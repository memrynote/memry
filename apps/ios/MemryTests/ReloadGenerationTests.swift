//
//  ReloadGenerationTests.swift
//  #4738: a block's row skips a read older than its last write, by write
//  generation, and draws every other read, whatever text it holds. Text
//  matching kept the screen on text the core no longer held after a fast
//  undo, a peer's revert, or a failed commit, and the next commit then wrote
//  the wrong change.
//

import Foundation
import MemryCore
import Synchronization
import SwiftUI
import Testing
import UIKit

@testable import Memry

@Suite("Reloads by write generation", .serialized)
@MainActor
struct ReloadGenerationTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let blockId: String
        let reader: CoreNotesReader
        let editor: CoreBlockEditor
    }

    private func fixture(_ text: String) throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Generations", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId,
            edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: text, newBlockId: blockId)
        )
        return Fixture(
            vault: vault, noteId: noteId, blockId: blockId,
            reader: CoreNotesReader(vault: vault.vault, executor: .shared),
            editor: CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        )
    }

    private static let due = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
    private static let moved = DateMentionValue(dateISO: "2026-07-14T09:00:00.000Z", hasTime: false)

    /// `hello ` and a date chip, anchored `dm_due`.
    private func fixtureWithDate() throws -> Fixture {
        let f = try fixture("hello ")
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId,
            edit: .insertInline(
                blockId: f.blockId, start: 6, end: 6, kind: "dateMention", text: "", attrs: Self.due.attrs(anchorId: "dm_due")
            )
        )
        return f
    }

    /// The core's editor, failing text writes while `fails` is set, and
    /// running `afterNext` once, after the next edit that lands.
    private final class Interposed: BlockEditing, Sendable {
        struct Failed: Error {}
        let core: CoreBlockEditor
        let fails = Mutex(false)
        /// Text writes still to fail, one each, before writes land again.
        let failures = Mutex(0)
        /// Fails located edits, such as a date rewrite's swap, after
        /// running `afterNext`.
        let failsLocated = Mutex(false)
        let afterNext = Mutex<(@Sendable @MainActor () async -> Void)?>(nil)
        init(_ core: CoreBlockEditor) { self.core = core }

        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            if case .replaceText = edit, fails.withLock({ $0 }) { throw Failed() }
            if case .replaceText = edit, failures.withLock({ left in
                defer { left = max(0, left - 1) }
                return left > 0
            }) { throw Failed() }
            let landed = try await core.edit(noteId: noteId, edit)
            await after()
            return landed
        }

        func edit(
            noteId: String, blockId: String, locating locate: @escaping @Sendable ([InlineRun]?) -> BlockEdit?
        ) async throws -> LocatedEdit {
            if failsLocated.withLock({ $0 }) {
                await after()
                throw Failed()
            }
            let located = try await core.edit(noteId: noteId, blockId: blockId, locating: locate)
            await after()
            return located
        }

        private func after() async {
            let run = afterNext.withLock { run in
                defer { run = nil }
                return run
            }
            await run?()
        }
    }

    /// Holds the session's write queue until `open`, so commits queue up
    /// behind it.
    @MainActor
    private final class Gate {
        private var waiting: CheckedContinuation<Void, Never>?
        private var opened = false

        init(_ session: EditorSession) {
            session.enqueue { [self] in
                guard !opened else { return }
                await withCheckedContinuation { waiting = $0 }
            }
        }

        func open() {
            opened = true
            waiting?.resume()
            waiting = nil
        }
    }

    /// A read the page took, and the writes it includes.
    private struct Read {
        let generation: Int
        let block: Block
    }

    @MainActor
    private final class Late {
        var read: Read?
    }

    /// The page's blocks and the writes they include.
    @MainActor
    private final class Drawn {
        var blocks: [Block] = []
        var generation = 0
    }

    /// One pane on the note: its model, and its block's row, drawn.
    @MainActor
    private struct Pane {
        let f: Fixture
        let model: NoteEditorViewModel
        let field: BlockField

        init(_ f: Fixture, editor: (any BlockEditing)? = nil) async throws {
            self.f = f
            model = NoteEditorViewModel(noteId: f.noteId, editor: editor ?? f.editor)
            model.session.model = model
            let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
            let blocks = try #require(try await f.reader.blocks(id: f.noteId))
            field = BlockField(
                block: try #require(blocks.first { $0.id == f.blockId }), session: model.session, style: style, alignment: .natural
            )
            field.render()
        }

        /// As `NoteReadViewModel.loadBlocks` reads: stamped as it begins.
        func read() async throws -> Read {
            let generation = model.session.landedWrites
            let blocks = try #require(try await f.reader.blocks(id: f.noteId))
            return Read(generation: generation, block: try #require(blocks.first { $0.id == f.blockId }))
        }

        func deliver(_ read: Read, restyled: Bool = false) {
            field.receive(read.block, generation: read.generation, restyled: restyled)
        }

        /// The page re-reads after each write, and its row gets that read.
        func rereads() {
            let pane = self
            model.session.reload = { if let read = try? await pane.read() { pane.deliver(read) } }
        }

        /// The page as `NotePageContent` wires it, with SwiftUI updating no
        /// row: each write's re-read only replaces the page's blocks and
        /// their stamp, as when the blocks it read equal the ones drawn.
        func drawsWithoutUpdates() {
            let pane = self
            let drawn = Drawn()
            model.session.reload = {
                guard let read = try? await pane.read() else { return }
                drawn.blocks = [read.block]
                drawn.generation = read.generation
            }
            model.session.blocks = { drawn.blocks }
            model.session.drawnGeneration = { drawn.generation }
            model.session.drawn(field)
        }

        func type(_ text: String) {
            field.textView.text = text
            field.dirty = true
        }

        func commit() async {
            model.session.commit(field)
            await model.session.tail?.value
        }

        var stored: String {
            get async throws { BlockText.shown(try await read().block.inline) }
        }
    }

    /// ⌘Z ⌘Z ⌘⇧Z after two commits: the row shows the core's text, also
    /// when the page drew none of the steps' reads until the last
    /// (SwiftUI coalesces the updates).
    @Test(.timeLimit(.minutes(1)), arguments: [true, false])
    func undoUndoRedoShowsTheCoresText(coalesced: Bool) async throws {
        let pane = try await Pane(try fixture(""))
        if !coalesced { pane.rereads() }
        pane.type("a")
        await pane.commit()
        pane.type("ab")
        await pane.commit()

        for step in [pane.model.session.undo, pane.model.session.undo, pane.model.session.redo] {
            step()
            await pane.model.session.tail?.value
        }
        if coalesced { pane.deliver(try await pane.read()) }

        #expect(try await pane.stored == "a")
        #expect(pane.field.textView.text == "a")
        // The next keys go onto what the core holds.
        pane.type("ac")
        await pane.commit()
        #expect(try await pane.stored == "ac")
    }

    /// The other pane puts the block back to exactly the text this row
    /// committed before its last commit, between that commit and its
    /// re-read. The row draws it.
    @Test(.timeLimit(.minutes(1))) func anotherPaneRevertingToAnOlderTextIsDrawn() async throws {
        let f = try fixture("a")
        let a = try await Pane(f)
        let b = try await Pane(f)
        var reverted = false
        a.model.session.reload = {
            if !reverted {
                reverted = true
                await b.model.commit("a", for: f.blockId, base: "ab")
            }
            if let read = try? await a.read() { a.deliver(read) }
        }

        a.type("ab")
        await a.commit()

        #expect(reverted)
        #expect(try await a.stored == "a")
        #expect(a.field.textView.text == "a")
        #expect(!a.field.dirty)
    }

    /// REVIEW-4700: the last commit fails, then the row is restyled. It
    /// keeps the typing unsaved, the failure stays the status, and the next
    /// commit writes it.
    @Test(.timeLimit(.minutes(1))) func aFailedCommitKeepsItsTypingForTheNextCommit() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()

        pane.type("ab")
        editor.fails.withLock { $0 = true }
        await pane.commit()
        pane.deliver(try await pane.read(), restyled: true)

        #expect(try await pane.stored == "a")
        #expect(pane.field.textView.text == "ab")
        #expect(pane.field.dirty)
        if case .failed = pane.model.status {} else { Issue.record("status \(pane.model.status)") }

        editor.fails.withLock { $0 = false }
        await pane.commit()
        #expect(try await pane.stored == "ab")
        #expect(pane.field.textView.text == "ab")
        #expect(pane.model.status == .idle)
    }

    /// #4773: `a→ab` fails while `ab→abc` is queued behind it. The queued
    /// commit carries the failed one's typing, so the core holds `abc`,
    /// and undo takes the one step back to `a`.
    @Test(.timeLimit(.minutes(1))) func aCommitQueuedBehindAFailedOneCarriesItsTyping() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        editor.failures.withLock { $0 = 1 }
        let gate = Gate(pane.model.session)

        pane.type("ab")
        pane.model.session.commit(pane.field)
        pane.type("abc")
        pane.model.session.commit(pane.field)
        gate.open()
        await pane.model.session.tail?.value

        #expect(try await pane.stored == "abc")
        #expect(pane.field.textView.text == "abc")
        #expect(!pane.field.dirty)
        #expect(pane.model.status == .idle)

        pane.model.session.undo()
        await pane.model.session.tail?.value
        #expect(try await pane.stored == "a")
        #expect(!pane.model.session.canUndo)
    }

    /// #4773, REVIEW-4770 Low 2: the row is taken over (a list shortcut
    /// redrew it) before its failed commit lands. The row that took over
    /// keeps the typing unsaved, or sends it with its own next commit.
    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func aFailedCommitReachesTheRowThatTookOver(typesOn: Bool) async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let old = try await Pane(f, editor: editor)
        old.rereads()
        let session = old.model.session
        session.drawn(old.field)
        editor.failures.withLock { $0 = 1 }
        let gate = Gate(session)

        old.type("ab")
        session.commit(old.field)
        // The row drawn anew from the core, taking over the old one's caret.
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let block = try #require(try await f.reader.blocks(id: f.noteId)?.first { $0.id == f.blockId })
        let row = BlockField(block: block, session: session, style: style, alignment: .natural)
        row.render()
        session.drawn(row)
        session.shortcutField = old.field
        row.textViewDidBeginEditing(row.textView)
        #expect(row.textView.text == "ab")
        if typesOn {
            row.textView.text = "abc"
            row.dirty = true
            session.commit(row)
        }
        gate.open()
        await session.tail?.value

        let typed = typesOn ? "abc" : "ab"
        if typesOn {
            #expect(try await old.stored == "abc")
            #expect(!row.dirty)
        } else {
            #expect(try await old.stored == "a")
            #expect(row.dirty)
            if case .failed = old.model.status {} else { Issue.record("status \(old.model.status)") }
            session.commit(row)
            await session.tail?.value
            #expect(try await old.stored == typed)
        }
        #expect(row.textView.text == typed)
        #expect(old.model.status == .idle)
    }

    /// #4773: `a→ab` and `ab→abc` both fail. The row keeps `abc` unsaved
    /// over the core's `a`, says so, and the next commit lands it.
    @Test(.timeLimit(.minutes(1))) func twoFailedCommitsInARowKeepTheTypingForTheNext() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        editor.failures.withLock { $0 = 2 }
        let gate = Gate(pane.model.session)

        pane.type("ab")
        pane.model.session.commit(pane.field)
        pane.type("abc")
        pane.model.session.commit(pane.field)
        gate.open()
        await pane.model.session.tail?.value

        #expect(try await pane.stored == "a")
        #expect(pane.field.textView.text == "abc")
        #expect(pane.field.dirty)
        if case .failed = pane.model.status {} else { Issue.record("status \(pane.model.status)") }

        await pane.commit()
        #expect(try await pane.stored == "abc")
        #expect(pane.field.textView.text == "abc")
        #expect(!pane.field.dirty)
        #expect(pane.model.status == .idle)
        pane.model.session.undo()
        await pane.model.session.tail?.value
        #expect(try await pane.stored == "a")
    }

    /// REVIEW-4784: a failed commit that drew a typed `[[link]]` as its chip
    /// puts the literal back in the row and keeps it unsaved, from the
    /// core's text (REVIEW-4778 redrew the row and lost the typing). A
    /// peer's write and the next typing then land with it.
    @Test(.timeLimit(.minutes(1))) func aFailedLinkCommitKeepsItsTypingForTheNextCommit() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        editor.failures.withLock { $0 = 1 }

        pane.type("a [[t]]")
        await pane.commit()
        #expect(try await pane.stored == "a")
        #expect(pane.field.textView.text == "a [[t]]")
        #expect(pane.field.dirty)
        #expect(pane.field.base == "a")

        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId, edit: .replaceText(blockId: f.blockId, text: "xa", base: "a")
        )
        pane.deliver(try await pane.read())
        #expect(pane.field.textView.text == "a [[t]]")
        pane.type("a [[t]]q")
        await pane.commit()

        #expect(try await pane.stored == "xa \u{FFFC}q")
    }

    /// REVIEW-4784: a link picked from the `[[` menu, keys typed after it,
    /// and the pick's text write fails. The row puts back the text the
    /// chip stood for and keeps it unsaved, so the next commit writes the
    /// typing, as it does for a failed plain commit.
    @Test(.timeLimit(.minutes(1))) func typingAroundAPickWhoseWriteFailedLandsWithTheNextCommit() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let session = pane.model.session
        session.linkNotes = [
            NoteSummary(id: "pane", title: "Pane", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []),
        ]
        session.focusChanged(to: pane.field)
        pane.type("a see [[pan")
        pane.field.textView.selectedRange = NSRange(location: 11, length: 0)
        session.selectionChanged(in: pane.field)
        editor.failures.withLock { $0 = 1 }

        session.choose(try #require(session.suggestions.first))
        #expect(pane.field.textView.text == "a see \u{FFFC} ")
        pane.field.textView.insertText(" and more")
        pane.field.dirty = true
        await session.tail?.value

        #expect(pane.field.textView.text == "a see   and more")
        #expect(pane.field.dirty)
        await pane.commit()
        // No link at the block's end: the failed write's nodes stay out.
        #expect(try await pane.stored == "a see   and more")
        #expect(pane.model.status == .idle)
    }

    /// REVIEW-4784 High: a commit queued behind a pick whose write fails
    /// carries its typing, with the pick's chip left out, as the core never
    /// got it. One undo step takes it all back.
    @Test(.timeLimit(.minutes(1))) func aCommitQueuedBehindAFailedPickCarriesItsTyping() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let session = pane.model.session
        session.linkNotes = [
            NoteSummary(id: "pane", title: "Pane", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []),
        ]
        session.focusChanged(to: pane.field)
        pane.type("a see [[pan")
        pane.field.textView.selectedRange = NSRange(location: 11, length: 0)
        session.selectionChanged(in: pane.field)
        editor.failures.withLock { $0 = 1 }
        let gate = Gate(session)

        session.choose(try #require(session.suggestions.first))
        #expect(pane.field.textView.text == "a see \u{FFFC} ")
        pane.field.textView.insertText(" and more")
        pane.field.dirty = true
        session.commit(pane.field)
        gate.open()
        await session.tail?.value

        #expect(try await pane.stored == "a see   and more")
        #expect(pane.field.textView.text == "a see   and more")
        #expect(!pane.field.dirty)
        #expect(pane.model.status == .idle)

        session.undo()
        await session.tail?.value
        #expect(try await pane.stored == "a")
        #expect(!session.canUndo)
    }

    /// REVIEW-4784 High: the same for a typed `[[x]]` drawn as its chip.
    /// The queued commit sends the literal, which stays text.
    @Test(.timeLimit(.minutes(1))) func aCommitQueuedBehindAFailedTypedLinkCarriesItsTyping() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let session = pane.model.session
        editor.failures.withLock { $0 = 1 }
        let gate = Gate(session)

        pane.type("a see [[x]]")
        pane.field.textView.selectedRange = NSRange(location: 11, length: 0)
        session.commit(pane.field)
        #expect(pane.field.textView.text == "a see \u{FFFC}")
        pane.field.textView.insertText(" and more")
        pane.field.dirty = true
        session.commit(pane.field)
        gate.open()
        await session.tail?.value

        #expect(try await pane.stored == "a see [[x]] and more")
        #expect(pane.field.textView.text == "a see [[x]] and more")
        #expect(!pane.field.dirty)
        #expect(pane.model.status == .idle)
    }

    /// REVIEW-4784: both the typed link's commit and the one queued behind
    /// it fail. The row gets the literal back, unsaved, and the next commit
    /// lands it all.
    @Test(.timeLimit(.minutes(1))) func twoFailedCommitsAfterATypedLinkKeepTheTypingForTheNext() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let session = pane.model.session
        editor.failures.withLock { $0 = 2 }
        let gate = Gate(session)

        pane.type("a see [[x]]")
        pane.field.textView.selectedRange = NSRange(location: 11, length: 0)
        session.commit(pane.field)
        pane.field.textView.insertText(" and more")
        pane.field.dirty = true
        session.commit(pane.field)
        gate.open()
        await session.tail?.value

        #expect(try await pane.stored == "a")
        #expect(pane.field.textView.text == "a see [[x]] and more")
        #expect(pane.field.dirty)
        await pane.commit()
        #expect(try await pane.stored == "a see \u{FFFC} and more")
    }

    /// REVIEW-4778: the failure lands on the old row of a takeover, and the
    /// row that took over is redrawn from the core. A peer's write and the
    /// next typing go from that redraw.
    @Test(.timeLimit(.minutes(1))) func typingAfterAFailureOnADeadRowGoesFromTheRedraw() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let old = try await Pane(f, editor: editor)
        let session = old.model.session
        session.drawn(old.field)
        editor.failures.withLock { $0 = 1 }
        let gate = Gate(session)

        old.type("ab")
        session.commit(old.field)
        // Never registered as the block's row: the restore finds the old one.
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let block = try #require(try await f.reader.blocks(id: f.noteId)?.first { $0.id == f.blockId })
        let row = BlockField(block: block, session: session, style: style, alignment: .natural)
        row.render()
        session.shortcutField = old.field
        row.textViewDidBeginEditing(row.textView)
        gate.open()
        await session.tail?.value

        let redraw = try await old.read()
        row.receive(redraw.block, generation: redraw.generation)
        #expect(row.textView.text == "a")
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId, edit: .replaceText(blockId: f.blockId, text: "xa", base: "a")
        )
        let peer = try await old.read()
        row.receive(peer.block, generation: peer.generation)
        #expect(row.textView.text == "xa")
        row.textView.text = "xaq"
        row.dirty = true
        session.commit(row)
        await session.tail?.value

        #expect(try await old.stored == "xaq")
    }

    /// REVIEW-4778 Low: a commit split around a node lands its first step
    /// and fails its second. The commit queued behind it goes from the
    /// step that landed, so the first step's typing is not written twice.
    @Test(.timeLimit(.minutes(1))) func aCommitQueuedBehindAPartlyLandedSplitGoesFromTheLandedStep() async throws {
        let f = try fixtureWithDate()
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        editor.afterNext.withLock { $0 = { editor.failures.withLock { $0 = 1 } } }
        let gate = Gate(pane.model.session)

        pane.field.textView.textStorage.insert(NSAttributedString(string: "X"), at: 0)
        pane.field.textView.textStorage.append(NSAttributedString(string: "Y"))
        pane.field.dirty = true
        pane.model.session.commit(pane.field)
        pane.field.textView.textStorage.append(NSAttributedString(string: "Z"))
        pane.field.dirty = true
        pane.model.session.commit(pane.field)
        gate.open()
        await pane.model.session.tail?.value

        #expect(try await pane.stored == "Xhello \u{FFFC}YZ")
        #expect(pane.field.textView.text == "Xhello \u{FFFC}YZ")
        #expect(!pane.field.dirty)
    }

    /// A read taken between the writes of a commit split around a node
    /// (`BlockText.stepsAroundNodes`) is older than the commit, so the row
    /// skips it when it lands after the commit's own re-read.
    @Test(.timeLimit(.minutes(1))) func aReadBetweenASplitCommitsWritesIsSkipped() async throws {
        let f = try fixtureWithDate()
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let late = Late()
        editor.afterNext.withLock { $0 = { late.read = try? await pane.read() } }

        pane.field.textView.textStorage.insert(NSAttributedString(string: "X"), at: 0)
        pane.field.textView.textStorage.append(NSAttributedString(string: "Y"))
        pane.field.dirty = true
        await pane.commit()
        let read = try #require(late.read)
        #expect(BlockText.shown(read.block.inline) == "Xhello \u{FFFC}")
        pane.deliver(read)

        #expect(try await pane.stored == "Xhello \u{FFFC}Y")
        #expect(pane.field.textView.text == "Xhello \u{FFFC}Y")
    }

    /// #4764: a date edit swaps its chip for a space, then puts the node
    /// back. A read between the two is older than the edit, so the row
    /// skips it when it lands after the edit's own re-read.
    @Test(.timeLimit(.minutes(1))) func aReadBetweenADateEditsTwoWritesIsSkipped() async throws {
        let f = try fixtureWithDate()
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.rereads()
        let late = Late()
        editor.afterNext.withLock { $0 = { late.read = try? await pane.read() } }

        let range = try #require(pane.field.dateChipRange(anchorId: "dm_due"))
        let chip = try #require(
            pane.field.textView.textStorage.attribute(.memryDate, at: range.location, effectiveRange: nil) as? DateMentionChip
        )
        pane.model.session.requestDateEdit(chip, in: pane.field)
        pane.model.session.applyDateEdit(.update(Self.moved))
        await pane.model.session.tail?.value
        let read = try #require(late.read)
        #expect(BlockText.shown(read.block.inline) == "hello  ")
        pane.deliver(read)

        #expect(pane.field.textView.text == "hello \u{FFFC}")
        let drawn = pane.field.textView.textStorage.attribute(.memryDate, at: range.location, effectiveRange: nil) as? DateMentionChip
        #expect(drawn?.value == Self.moved)
    }

    /// REVIEW-4770 Low 1: a commit of the text the row was drawn with sends
    /// nothing, so a peer's change read while it was queued is drawn, not
    /// held back as older than a write that never happened.
    @Test(.timeLimit(.minutes(1))) func aCommitThatSendsNothingHoldsBackNoRead() async throws {
        let f = try fixture("a")
        let pane = try await Pane(f)
        pane.type("a")
        pane.model.session.commit(pane.field)
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId, edit: .replaceText(blockId: f.blockId, text: "ab", base: "a")
        )
        let read = try await pane.read()
        pane.deliver(read)
        await pane.model.session.tail?.value

        #expect(read.generation == 0)
        #expect(pane.field.textView.text == "ab")
    }

    /// REVIEW-4770 Low 1: a refused date edit leaves the block as it was.
    /// The peer's change the row skipped while the edit was queued is drawn
    /// once the edit's re-read is in, though SwiftUI updates no row.
    @Test(.timeLimit(.minutes(1))) func aRefusedDateEditDrawsThePeersChangeItHeldBack() async throws {
        let f = try fixtureWithDate()
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        let peer = try await Pane(f)
        pane.drawsWithoutUpdates()
        editor.failsLocated.withLock { $0 = true }
        let skipped = Late()
        editor.afterNext.withLock {
            $0 = {
                _ = await peer.model.commit("Xhello \u{FFFC}", for: f.blockId, base: "hello \u{FFFC}")
                skipped.read = try? await pane.read()
                if let read = skipped.read { pane.deliver(read) }
            }
        }

        let range = try #require(pane.field.dateChipRange(anchorId: "dm_due"))
        let chip = try #require(
            pane.field.textView.textStorage.attribute(.memryDate, at: range.location, effectiveRange: nil) as? DateMentionChip
        )
        pane.model.session.requestDateEdit(chip, in: pane.field)
        pane.model.session.applyDateEdit(.update(Self.moved))
        await pane.model.session.tail?.value

        #expect(try #require(skipped.read).generation < pane.field.written)
        #expect(try await pane.stored == "Xhello \u{FFFC}")
        #expect(pane.field.textView.text == "Xhello \u{FFFC}")
    }

    /// REVIEW-4770 Low 3: a failed text write leaves no undo step, which
    /// would replay typing the core never had. REVIEW-4784: nor its nodes,
    /// whose places are in that typing.
    @Test(.timeLimit(.minutes(1))) func nodesAfterAFailedTextWriteLeaveNoUndoStep() async throws {
        let f = try fixture("a")
        let editor = Interposed(f.editor)
        let pane = try await Pane(f, editor: editor)
        pane.type("ab")
        editor.fails.withLock { $0 = true }
        let blockId = f.blockId
        pane.model.session.commit(pane.field, inserting: { model in
            let at = NodeAnchor.at(1, in: NSAttributedString(string: "a"), replaces: false)
            return await model.insertDateMention(in: blockId, at: at, value: Self.due).map { [$0] } ?? []
        })
        await pane.model.session.tail?.value

        #expect(try await pane.stored == "a")
        #expect(!pane.model.session.canUndo)
    }

    /// REVIEW-4770 Low 6: the note page as production builds it. Its read
    /// model stamps each read with the page session's landed writes, and
    /// the row reads that stamp, so another device's change read after the
    /// row's own commit is drawn.
    @Test(.timeLimit(.minutes(1))) func thePageDrawsAChangeReadAfterTheRowsCommit() async throws {
        let f = try fixture("a")
        let model = NoteReadViewModel(route: NoteRoute(id: f.noteId), reader: f.reader)
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        window.rootViewController = UIHostingController(rootView: NoteReadView(
            model: model, editor: f.editor, notifications: NotificationCenter()
        ))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        func row() -> BlockTextView? {
            func all(_ view: UIView) -> [BlockTextView] { ((view as? BlockTextView).map { [$0] } ?? []) + view.subviews.flatMap(all) }
            return all(window).first
        }
        func until(_ condition: () -> Bool) async {
            for _ in 0 ..< 300 where !condition() {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        await until { row()?.text == "a" }
        let field = try #require(row(), "the body has no row")
        field.becomeFirstResponder()
        field.selectedRange = NSRange(location: 1, length: 0)
        if field.delegate?.textView?(field, shouldChangeTextIn: field.selectedRange, replacementText: "b") != false {
            field.insertText("b")
        }
        field.resignFirstResponder()
        await until { model.blocksGeneration > 0 }
        #expect(model.blocksGeneration > 0, "the page stamped no read with the row's commit")
        let stored = try await f.reader.blocks(id: f.noteId)?.first { $0.id == f.blockId }
        #expect(stored.map { BlockText.shown($0.inline) } == "ab")

        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId, edit: .replaceText(blockId: f.blockId, text: "abc", base: "ab")
        )
        await model.reload()
        await until { field.text == "abc" }
        #expect(field.text == "abc")
    }
}
