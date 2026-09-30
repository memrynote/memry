//
//  BlockActionsTests.swift
//  The block menu: which siblings Move up and Move down swap with, and the
//  operations each action writes.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

@testable import Memry

private final class RecordingBlockEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    /// Whether this editor reads snapshots, as the core does; the journal and
    /// older fakes do not.
    let snapshots: Bool

    init(snapshots: Bool = false) {
        self.snapshots = snapshots
    }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }

    /// A snapshot named after the block and how many writes came before it,
    /// so a test can tell the one read before a write from the one after.
    func snapshot(noteId: String, blockId: String) async throws -> String? {
        guard snapshots else { return nil }
        return "\(blockId)@\(edits.withLock { $0.count })"
    }

    var all: [BlockEdit] { edits.withLock { $0 } }
}

private func block(_ id: String, depth: UInt32 = 0, kind: String = "paragraph", props: [String: String] = [:])
    -> Block
{
    Block(
        id: id, kind: kind, depth: depth,
        props: props.map { BlockProp(name: $0.key, value: $0.value) },
        inline: []
    )
}

@Suite("Block siblings")
struct BlockSiblingsTests {
    @Test func top_level_blocks_swap_with_their_neighbours() {
        let blocks = [block("a"), block("b"), block("c")]
        #expect(BlockSiblings.of(1, in: blocks) == BlockSiblings(previous: "a", next: "c"))
        #expect(BlockSiblings.of(0, in: blocks) == BlockSiblings(previous: nil, next: "b"))
        #expect(BlockSiblings.of(2, in: blocks) == BlockSiblings(previous: "b", next: nil))
    }

    @Test func a_siblings_children_are_stepped_over() {
        // a, a's child a1, then b: b's previous sibling is a, not a1.
        let blocks = [block("a"), block("a1", depth: 1), block("b")]
        #expect(BlockSiblings.of(2, in: blocks).previous == "a")
        #expect(BlockSiblings.of(0, in: blocks).next == "b")
    }

    @Test func a_nested_block_stays_inside_its_parent() {
        // p holds x and y; z is p's sibling. y has no next sibling, x no
        // previous one: moving would leave the parent.
        let blocks = [block("p"), block("x", depth: 1), block("y", depth: 1), block("z")]
        #expect(BlockSiblings.of(1, in: blocks) == BlockSiblings(previous: nil, next: "y"))
        #expect(BlockSiblings.of(2, in: blocks) == BlockSiblings(previous: "x", next: nil))
    }

    @Test func an_index_out_of_range_has_no_siblings() {
        #expect(BlockSiblings.of(3, in: [block("a")]) == BlockSiblings())
    }
}

@Suite("Block action steps")
struct BlockActionStepTests {
    @Test func move_up_moves_the_previous_sibling_below_and_undo_moves_it_back() throws {
        let step = try #require(
            EditorUndoStep.moveUp(blockId: "b", siblings: BlockSiblings(previous: "a", next: nil))
        )
        #expect(step.forward == .moveBlock(blockId: "a", afterBlockId: "b"))
        #expect(step.backward == .moveBlock(blockId: "b", afterBlockId: "a"))
    }

    @Test func move_down_moves_the_block_below_its_next_sibling() throws {
        let step = try #require(
            EditorUndoStep.moveDown(blockId: "a", siblings: BlockSiblings(previous: nil, next: "b"))
        )
        #expect(step.forward == .moveBlock(blockId: "a", afterBlockId: "b"))
        #expect(step.backward == .moveBlock(blockId: "b", afterBlockId: "a"))
    }

    @Test func no_sibling_means_no_move() {
        #expect(EditorUndoStep.moveUp(blockId: "a", siblings: BlockSiblings()) == nil)
        #expect(EditorUndoStep.moveDown(blockId: "a", siblings: BlockSiblings()) == nil)
    }

    @Test func duplicate_is_undone_by_deleting_the_copy() {
        let step = EditorUndoStep.duplicate(blockId: "a", newBlockId: "copy")
        #expect(step.forward == .duplicate(blockId: "a", newBlockId: "copy"))
        #expect(step.backward == .delete(blockId: "copy"))
    }

    @Test func turn_into_and_colours_follow_desktops_text_block_rule() {
        let divider = BlockActionTarget(block: block("d", kind: "divider"), siblings: BlockSiblings())
        let code = BlockActionTarget(block: block("c", kind: "codeBlock"), siblings: BlockSiblings())
        let callout = BlockActionTarget(block: block("k", kind: "callout"), siblings: BlockSiblings())
        #expect(!divider.canTurnInto && !divider.canColour)
        #expect(code.canTurnInto && !code.canColour)
        #expect(callout.canTurnInto && callout.canColour)
    }

    @Test func the_current_heading_level_is_the_checked_choice() throws {
        let target = BlockActionTarget(
            block: block("h", kind: "heading", props: ["level": "2"]), siblings: BlockSiblings()
        )
        let h2 = try #require(InsertableBlock.all.first { $0.id == "heading" && $0.level == 2 })
        let h1 = try #require(InsertableBlock.all.first { $0.id == "heading" && $0.level == 1 })
        #expect(target.isCurrent(h2))
        #expect(!target.isCurrent(h1))
    }
}

@Suite("Block action runner")
@MainActor
struct BlockActionRunnerTests {
    private func run(
        _ target: BlockActionTarget, snapshots: Bool = false, _ action: (BlockActionRunner) -> Void
    ) async -> (RecordingBlockEditor, EditorSession) {
        let editor = RecordingBlockEditor(snapshots: snapshots)
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        session.model = model
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            action(BlockActionRunner(session: session, target: target))
        }
        return (editor, session)
    }

    @Test func move_up_writes_the_swap_and_lands_on_the_undo_stack() async {
        let target = BlockActionTarget(block: block("b"), siblings: BlockSiblings(previous: "a", next: nil))
        let (editor, session) = await run(target) { $0.moveUp() }
        #expect(editor.all == [.moveBlock(blockId: "a", afterBlockId: "b")])
        #expect(session.history.undoName == "Move up")
    }

    @Test func moving_the_focused_block_keeps_the_caret_in_it() async throws {
        let editor = RecordingBlockEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        session.model = model
        let blocks = [block("a"), block("b"), block("c")]
        session.blocks = { blocks }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: blocks[1], session: session, style: style, alignment: .natural)
        session.focusChanged(to: field)
        let runner = try #require(session.focusedRunner)
        #expect(runner.target.siblings == BlockSiblings(previous: "a", next: "c"))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            runner.moveDown()
        }
        #expect(editor.all == [.moveBlock(blockId: "b", afterBlockId: "c")])
        #expect(session.pendingFocus == "b")
        #expect(session.history.undoName == "Move down")
    }

    @Test func moving_a_block_without_the_caret_moves_no_caret() async {
        let target = BlockActionTarget(block: block("b"), siblings: BlockSiblings(previous: nil, next: "c"))
        let (_, session) = await run(target) { $0.moveDown() }
        #expect(session.pendingFocus == nil)
    }

    @Test func a_background_colour_is_a_block_prop_undone_to_the_old_value() async {
        let target = BlockActionTarget(
            block: block("b", props: ["backgroundColor": "red"]), siblings: BlockSiblings()
        )
        let (editor, session) = await run(target) { $0.setColour("backgroundColor", "blue") }
        #expect(editor.all == [.setProp(blockId: "b", name: "backgroundColor", value: "blue")])
        #expect(session.history.popUndo()?.backward == .setProp(blockId: "b", name: "backgroundColor", value: "red"))
    }

    @Test func turning_into_a_heading_writes_its_level() async throws {
        let h3 = try #require(InsertableBlock.all.first { $0.id == "heading" && $0.level == 3 })
        let target = BlockActionTarget(block: block("b", kind: "callout"), siblings: BlockSiblings())
        let (editor, _) = await run(target) { $0.turnInto(h3) }
        #expect(editor.all == [
            .turnInto(blockId: "b", kind: "heading"),
            .setProp(blockId: "b", name: "level", value: "3"),
        ])
    }

    @Test func delete_without_a_snapshot_read_is_not_undoable() async {
        let target = BlockActionTarget(block: block("b"), siblings: BlockSiblings())
        let (editor, session) = await run(target) { $0.delete() }
        #expect(editor.all == [.delete(blockId: "b")])
        #expect(!session.history.canUndo)
    }

    @Test func delete_is_undone_by_restoring_the_snapshot_read_before_it() async throws {
        let target = BlockActionTarget(block: block("b"), siblings: BlockSiblings())
        let (editor, session) = await run(target, snapshots: true) { $0.delete() }
        #expect(editor.all == [.delete(blockId: "b")])
        #expect(session.history.undoName == "Delete")
        let step = try #require(session.history.popUndo())
        #expect(step.backward == .restoreBlock(snapshot: "b@0"))
        #expect(step.forward == .delete(blockId: "b"))
    }

    @Test func turn_into_is_undone_from_the_block_as_it_was_and_redone_as_it_became() async throws {
        let h2 = try #require(InsertableBlock.all.first { $0.id == "heading" && $0.level == 2 })
        let target = BlockActionTarget(block: block("b"), siblings: BlockSiblings())
        let (editor, session) = await run(target, snapshots: true) { $0.turnInto(h2) }
        #expect(editor.all == [
            .turnInto(blockId: "b", kind: "heading"),
            .setProp(blockId: "b", name: "level", value: "2"),
        ])
        let step = try #require(session.history.popUndo())
        #expect(step.backward == .restoreBlock(snapshot: "b@0"))
        #expect(step.forward == .restoreBlock(snapshot: "b@2"))
    }

    @Test func turn_into_without_a_snapshot_read_falls_back_to_the_type_change() async throws {
        let target = BlockActionTarget(block: block("b", kind: "quote"), siblings: BlockSiblings())
        let paragraph = try #require(InsertableBlock.all.first { $0.id == "paragraph" })
        let (_, session) = await run(target) { $0.turnInto(paragraph) }
        #expect(session.history.popUndo()?.backward == .turnInto(blockId: "b", kind: "quote"))
    }
}
