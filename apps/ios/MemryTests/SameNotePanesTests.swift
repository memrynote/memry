//
//  SameNotePanesTests.swift
//  #4377: two panes on one note write through the vault's one editor to the
//  note's one document. Each pane draws the block it last read, so a pane can
//  hold typing on a block another pane has changed since. Its commit must keep
//  both panes' typing.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

@Suite("Two panes on one note", .serialized)
@MainActor
struct SameNotePanesTests {
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
        let noteId = try writer.create(title: "Agent Panes", folderPath: nil)
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

    /// One pane's page: its model and session, as `NotePageContent` builds them.
    private func pane(_ f: Fixture) -> NoteEditorViewModel {
        let model = NoteEditorViewModel(noteId: f.noteId, editor: f.editor)
        model.session.model = model
        return model
    }

    private func block(_ f: Fixture) async throws -> Block {
        let blocks = try #require(try await f.reader.blocks(id: f.noteId))
        return try #require(blocks.first { $0.id == f.blockId })
    }

    private func stored(_ f: Fixture) async throws -> String {
        try await block(f).inline.map(\.text).joined()
    }

    /// The block's text view in `model`'s pane, drawn from `block`.
    private func draw(_ block: Block, in model: NoteEditorViewModel) -> BlockField {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
        field.render()
        return field
    }

    /// What a keystroke leaves: the new text, unsaved.
    private func type(_ text: String, in field: BlockField) {
        field.textView.text = text
        field.dirty = true
    }

    private func commit(_ field: BlockField, in model: NoteEditorViewModel) async {
        model.session.commit(field)
        await model.session.tail?.value
    }

    /// Pane B starts typing, pane A's edit lands, and B commits before it has
    /// re-read the note: B's block still shows the text both started from.
    @Test(.timeLimit(.minutes(1))) func a_pane_committing_before_it_rereads_keeps_the_other_panes_edit() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "A hello B")
        #expect(a.status == .idle)
        #expect(b.status == .idle)
    }

    /// B's page re-reads while it holds typing: the block moves on under the
    /// text view, which keeps what B typed (not redrawn over, #4519), and the
    /// commit lands only B's change on the live block.
    @Test(.timeLimit(.minutes(1))) func a_pane_rereading_under_its_typing_keeps_both_panes_edits() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        // What `updateUIView` does with the re-read block: a dirty field
        // takes the block and is not rendered.
        fieldB.block = try await block(f)
        #expect(fieldB.textView.text == "hello B")
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "A hello B")
    }

    /// Both panes keep typing across several commits each, interleaved.
    @Test(.timeLimit(.minutes(1))) func interleaved_commits_from_both_panes_keep_every_keystroke() async throws {
        let f = try fixture("mid")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("1 mid", in: fieldA)
        await commit(fieldA, in: a)
        type("mid 2", in: fieldB)
        await commit(fieldB, in: b)
        type("0 1 mid", in: fieldA)
        await commit(fieldA, in: a)
        type("mid 2 3", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "0 1 mid 2 3")
    }

    /// DATA-LOSS (REVIEW-4700): ⌘Z in B takes back only B's typing, and redo
    /// puts back only B's: A's typing in the same block, which landed after
    /// B's commit, stays through both.
    @Test(.timeLimit(.minutes(1))) func undo_and_redo_in_one_pane_keep_the_other_panes_typing() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        await commit(fieldB, in: b)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        #expect(try await stored(f) == "A hello B")

        b.session.undo()
        await b.session.tail?.value
        #expect(try await stored(f) == "A hello", "B's undo kept A's typing")
        b.session.redo()
        await b.session.tail?.value
        #expect(try await stored(f) == "A hello B", "B's redo kept A's typing")
    }

    /// A `[[target]]` B typed becomes a link where the block holds it after
    /// B's rebased commit, not at the offsets of B's stale text.
    @Test(.timeLimit(.minutes(1))) func a_link_typed_in_a_stale_pane_converts_where_the_block_holds_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC}")
        #expect(runs.last?.markAttrs["wikiLink.target"] == "Foo")
    }

    /// B's undo of a link it typed takes back the link and B's typing, and
    /// keeps A's: the step's text after is B's own, with the node in, not the
    /// block as the core holds it.
    @Test(.timeLimit(.minutes(1))) func undo_of_a_link_typed_in_a_stale_pane_keeps_the_other_panes_typing() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello \u{FFFC}")

        b.session.undo()
        await b.session.tail?.value
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello")
    }

    /// DATA-LOSS (REVIEW-4700): B's redo of a link it typed puts the node
    /// over the literal where the block holds it once the typing is back,
    /// not at the offsets B recorded: A has typed before it since.
    @Test(.timeLimit(.minutes(1))) func redo_of_a_typed_link_after_the_other_pane_typed_before_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)
        #expect(BlockText.shown(try await block(f).inline) == "hello \u{FFFC}")
        b.session.undo()
        await b.session.tail?.value
        #expect(try await stored(f) == "hello")
        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)

        b.session.redo()
        await b.session.tail?.value
        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC}", "A's typing intact, no partial literal")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    /// DATA-LOSS (REVIEW-4700): a tag B picks goes over its `#query` where
    /// the block holds it after B's rebased commit, not at B's stale offsets.
    @Test(.timeLimit(.minutes(1))) func a_tag_picked_in_a_stale_pane_goes_where_the_block_holds_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        b.session.tags = ["task"]
        b.session.focusChanged(to: fieldB)
        type("hello #ta", in: fieldB)
        fieldB.textView.selectedRange = NSRange(location: 9, length: 0)
        b.session.selectionChanged(in: fieldB)
        b.session.chooseTag(try #require(b.session.tagSuggestions.first { $0.tag == "task" }))
        await b.session.tail?.value

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC} ", "A's typing intact, no partial word")
        #expect(runs.filter { $0.marks.contains("hashTag") }.count == 1)
    }

    /// `field`'s text view in a key window, holding the caret at `selection`,
    /// as a tap in pane B leaves it.
    private func focus(_ field: BlockField, at selection: NSRange) throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 200)
        window.rootViewController = UIViewController()
        field.textView.delegate = field
        field.textView.frame = CGRect(x: 0, y: 40, width: 400, height: 60)
        window.rootViewController?.view.addSubview(field.textView)
        window.makeKeyAndVisible()
        #expect(field.textView.becomeFirstResponder())
        field.textView.selectedRange = selection
        return window
    }

    /// Keys as the keyboard delivers them: through the delegate, then
    /// `insertText` over the text view's selection.
    private func keys(_ text: String, in field: BlockField) {
        for character in text {
            let view = field.textView
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: String(character)) != false {
                view.insertText(String(character))
            }
        }
    }

    /// DATA-LOSS (VERIFY-4700): A types `XYZ ` at the block's start, B's page
    /// re-reads under B's caret and redraws, then B types. The caret moves
    /// with B's text, so B's keys land where B put the caret.
    @Test(.timeLimit(.minutes(1))) func a_redraw_under_the_caret_keeps_the_caret_on_its_text() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 14, length: 0))
        defer { window.isHidden = true }

        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.selectedRange == NSRange(location: 18, length: 0))
        keys(" zz", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "XYZ golf body text zz")
    }

    /// DATA-LOSS (VERIFY-4700): B's tap selected `text` before A's edit
    /// landed. The selection stays on `text`, so B's keys replace only it:
    /// no byte B did not select is lost.
    @Test(.timeLimit(.minutes(1))) func a_redraw_under_a_selection_keeps_the_selection_on_its_text() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 10, length: 4))
        defer { window.isHidden = true }

        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.selectedRange == NSRange(location: 14, length: 4))
        keys(" zz", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "XYZ golf body  zz")
    }

    /// An IME composition in B is not drawn over when A's edit lands: the
    /// redraw waits, then draws A's edit and the composed text.
    @Test(.timeLimit(.minutes(1))) func a_redraw_waits_for_a_composition_to_end() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 14, length: 0))
        defer { window.isHidden = true }

        fieldB.textView.setMarkedText("zz", selectedRange: NSRange(location: 2, length: 0))
        // A commit mid-composition (the scene leaving the foreground).
        await commit(fieldB, in: b)
        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.markedTextRange != nil, "the composition is kept")
        #expect(fieldB.textView.text == "golf body textzz")
        #expect(fieldB.stale)

        fieldB.textView.unmarkText()
        fieldB.render()
        #expect(!fieldB.stale)
        #expect(fieldB.textView.text == "XYZ golf body textzz")
        #expect(fieldB.textView.selectedRange == NSRange(location: 20, length: 0))
        #expect(try await stored(f) == "XYZ golf body textzz")
    }

    /// A pane's write is announced under its own source, so the other pane on
    /// the note re-reads (`NotePageLoad`) and the writer does not.
    @Test(.timeLimit(.minutes(1))) func a_landed_edit_is_announced_with_its_panes_source() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let fieldA = draw(try await block(f), in: a)
        // Other suites write in parallel: only this note's announcements.
        var heard: [UUID?] = []
        let token = NotificationCenter.default.addObserver(
            forName: AnnouncedEdits.bodyChanged, object: nil, queue: nil
        ) { [noteId = f.noteId] note in
            guard note.object as? String == noteId else { return }
            let source = note.userInfo?[AnnouncedEdits.sourceKey] as? UUID
            MainActor.assumeIsolated { heard.append(source) }
        }
        defer { NotificationCenter.default.removeObserver(token) }

        type("hello there", in: fieldA)
        await commit(fieldA, in: a)

        #expect(heard == [a.source])
    }
}

@Suite("A range carried across a redraw")
@MainActor
struct BlockTextCarryTests {
    @Test func a_caret_after_an_insert_moves_by_its_length() {
        #expect(BlockText.carry(NSRange(location: 4, length: 0), from: "golf", to: "XYZ golf") == NSRange(location: 8, length: 0))
    }

    @Test func a_caret_before_an_insert_stays() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "golf", to: "golf XYZ") == NSRange(location: 2, length: 0))
    }

    @Test func a_selection_after_a_deletion_moves_back() {
        #expect(BlockText.carry(NSRange(location: 8, length: 4), from: "XYZ golf body", to: "golf body") == NSRange(location: 4, length: 4))
    }

    @Test func a_caret_inside_a_replaced_span_goes_to_its_end() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "abcdef", to: "aXYZef") == NSRange(location: 4, length: 0))
    }

    @Test func a_selection_around_an_insert_grows_with_it() {
        #expect(BlockText.carry(NSRange(location: 0, length: 4), from: "golf", to: "goXlf") == NSRange(location: 0, length: 5))
    }

    @Test func offsets_count_utf16() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "ab", to: "🙂ab") == NSRange(location: 4, length: 0))
    }

    @Test func unchanged_text_keeps_the_range() {
        #expect(BlockText.carry(NSRange(location: 1, length: 2), from: "abc", to: "abc") == NSRange(location: 1, length: 2))
    }
}
