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
        let afterNext = Mutex<(@Sendable @MainActor () async -> Void)?>(nil)
        init(_ core: CoreBlockEditor) { self.core = core }

        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            if case .replaceText = edit, fails.withLock({ $0 }) { throw Failed() }
            let landed = try await core.edit(noteId: noteId, edit)
            await after()
            return landed
        }

        func edit(
            noteId: String, blockId: String, locating locate: @escaping @Sendable ([InlineRun]?) -> BlockEdit?
        ) async throws -> LocatedEdit {
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

    /// A read the page took, and the writes it includes.
    private struct Read {
        let generation: Int
        let block: Block
    }

    @MainActor
    private final class Late {
        var read: Read?
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
}
