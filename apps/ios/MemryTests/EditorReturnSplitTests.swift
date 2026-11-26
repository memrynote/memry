//
//  EditorReturnSplitTests.swift
//  #4834: Return inside a block's text splits it at the caret, as desktop's
//  Enter does, and a Backspace at the new block's start merges it back. On
//  the real core: marks and inline nodes stay on their side, and undo and
//  redo put each state back exactly.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

@Suite("Return splits a block at the caret", .serialized)
@MainActor
struct EditorReturnSplitTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let blockId: String
        let reader: CoreNotesReader
        let model: NoteEditorViewModel
    }

    /// `ab cd ` bold from `ab` to `cd`, a `#work` tag, then `ef`.
    private func fixture() throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Split", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        for edit: BlockEdit in [
            .insertBlock(kind: "paragraph", afterBlockId: nil, text: "ab cd ef", newBlockId: blockId),
            .setMark(blockId: blockId, start: 0, end: 5, mark: "bold", value: nil),
            .insertInline(blockId: blockId, start: 6, end: 6, kind: "hashTag", text: "#work", attrs: ["tag": "work"]),
        ] {
            _ = try writer.editBlock(noteId: noteId, edit: edit)
        }
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        model.session.model = model
        return Fixture(
            vault: vault, noteId: noteId, blockId: blockId,
            reader: CoreNotesReader(vault: vault.vault, executor: .shared), model: model
        )
    }

    private func blocks(_ f: Fixture) async throws -> [Block] {
        let blocks = try #require(try await f.reader.blocks(id: f.noteId))
        f.model.session.blocks = { blocks }
        return blocks
    }

    /// `block`'s text view, drawn as the page draws it, the caret at `caret`.
    private func draw(_ block: Block, in f: Fixture, caret: Int) -> BlockField {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: f.model.session, style: style, alignment: .natural)
        field.render()
        field.textView.selectedRange = NSRange(location: caret, length: 0)
        return field
    }

    private func settle(_ f: Fixture) async {
        f.model.session.enqueue {}
        await f.model.session.tail?.value
    }

    /// Each block's runs, as `text` with its marks.
    private func runs(_ blocks: [Block]) -> [[String]] {
        blocks.map { $0.inline.map { "\($0.text)\($0.marks.sorted())" } }
    }

    @Test(.timeLimit(.minutes(1))) func a_return_mid_text_splits_the_block_and_undo_and_redo_are_exact() async throws {
        let f = try fixture()
        let before = try await blocks(f)
        let field = draw(before[0], in: f, caret: 4)

        f.model.session.returnPressed(field)
        #expect(field.textView.text == "ab c", "the text after the caret leaves at once")
        await settle(f)
        let split = try await blocks(f)
        #expect(split.map { BlockText.shown($0.inline) } == ["ab c", "d \(BlockText.placeholder)ef"])
        #expect(split.map(\.kind) == ["paragraph", "paragraph"])
        #expect(runs(split) == [["ab c[\"bold\"]"], ["d[\"bold\"]", " []", "#work[\"hashTag\"]", "ef[]"]], "\(runs(split))")

        f.model.session.undo()
        await settle(f)
        #expect(runs(try await blocks(f)) == runs(before), "undo puts the block back whole")

        f.model.session.redo()
        await settle(f)
        let redone = try await blocks(f)
        #expect(runs(redone) == runs(split))
        #expect(redone.map(\.id) == split.map(\.id), "redo makes the same block again")
    }

    @Test(.timeLimit(.minutes(1))) func a_backspace_at_the_new_blocks_start_merges_it_back() async throws {
        let f = try fixture()
        let before = try await blocks(f)
        f.model.session.returnPressed(draw(before[0], in: f, caret: 4))
        await settle(f)
        let split = try await blocks(f)
        f.model.session.returnBurst = nil

        f.model.session.backspaceAtStart(draw(split[1], in: f, caret: 0))
        await settle(f)
        let merged = try await blocks(f)
        #expect(runs(merged) == runs(before), "\(runs(merged))")
        #expect(merged.map(\.id) == [f.blockId])

        f.model.session.undo()
        await settle(f)
        #expect(runs(try await blocks(f)) == runs(split), "undo of the merge splits again")
        f.model.session.redo()
        await settle(f)
        #expect(runs(try await blocks(f)) == runs(before))
    }

    /// The caret after a textless node keeps it above; before it, it moves.
    @Test(.timeLimit(.minutes(1)), arguments: [(3, ["ab\(BlockText.placeholder)", "cd"]), (2, ["ab", "\(BlockText.placeholder)cd"])])
    func a_date_goes_with_the_side_of_the_caret_it_is_on(caret: Int, expected: [String]) async throws {
        let f = try fixture()
        let writer = try f.vault.vault.notesWriter(store: TaskTestKeychain())
        _ = try writer.editBlock(noteId: f.noteId, edit: .setText(blockId: f.blockId, text: "abcd"))
        _ = try writer.editBlock(
            noteId: f.noteId,
            edit: .insertInline(blockId: f.blockId, start: 2, end: 2, kind: "dateMention", text: "", attrs: ["date": "2026-01-02"])
        )
        let before = try await blocks(f)
        f.model.session.returnPressed(draw(before[0], in: f, caret: caret))
        await settle(f)
        #expect(try await blocks(f).map { BlockText.shown($0.inline) } == expected)
    }
}
