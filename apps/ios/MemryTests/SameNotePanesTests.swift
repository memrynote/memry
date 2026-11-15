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
