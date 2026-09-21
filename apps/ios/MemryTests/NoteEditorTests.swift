//
//  NoteEditorTests.swift
//  N302 — the editable paragraph, held to the path it claims.
//

import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

/// Records every edit it is asked to make, and can be told to fail.
private final class ScriptedEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    private let answer: Bool
    private let failure: Error?

    init(answer: Bool = true, failure: Error? = nil) {
        self.answer = answer
        self.failure = failure
    }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        if let failure { throw failure }
        return answer
    }

    var count: Int { edits.withLock(\.count) }
}

@Suite("N302 the editable paragraph")
@MainActor
struct NoteEditorTests {

    /// The whole point of the skeleton: what the user typed reaches
    /// `editBlock` as a `SetText` naming the block they typed into.
    @Test func committing_a_block_reaches_the_core_as_a_set_text() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("the new text", for: "block-1", current: "the old text")

        #expect(editor.count == 1)
        let edit = editor.edits.withLock { $0.first }
        guard case let .setText(blockId, text) = edit else {
            Issue.record("expected a setText, got \(String(describing: edit))")
            return
        }
        #expect(blockId == "block-1")
        #expect(text == "the new text")
        #expect(model.status == .idle)
    }

    /// **An unchanged commit must write nothing.**
    ///
    /// Every write is a CRDT update *and* an outbox row (FR-030). Tapping into
    /// a block and back out without typing would otherwise enqueue a push of
    /// an edit that did not happen.
    @Test func tapping_into_a_block_and_out_again_writes_nothing() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("unchanged", for: "block-1", current: "unchanged")

        #expect(editor.count == 0, "an unchanged commit must not reach the core")
        #expect(model.status == .idle)
    }

    /// A note that is gone is an answer, not a crash — and the copy is the
    /// one the shell already has for exactly this, not a second sentence
    /// saying the same thing differently.
    @Test func editing_a_note_that_is_gone_says_so() async {
        let editor = ScriptedEditor(answer: false)
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("text", for: "block-1", current: "other")

        #expect(model.status == .failed(ErrorMapping.unknownNote))
    }

    /// A failed write is reported through `ErrorMapping`, never raw, and
    /// **the draft is kept**: discarding the user's text to report a failure
    /// about their text would lose the very thing being reported.
    @Test func a_failed_write_is_mapped_and_the_users_text_survives() async {
        let editor = ScriptedEditor(failure: CrdtError.DocumentBusy(docId: "d", what: "w"))
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("typed but unsaved", for: "block-1", current: "old")

        guard case let .failed(error) = model.status else {
            Issue.record("expected a failure, got \(model.status)")
            return
        }
        #expect(!error.title.isEmpty)
        #expect(error.code != ErrorMapping.unrecognised.code)
        #expect(
            model.text(for: "block-1", fallback: "old") == "typed but unsaved",
            "the draft must survive a failed write"
        )
    }

    /// Return at the end of a block inserts a paragraph after it, and the new
    /// id is minted by the shell so the caret can move without a second read.
    @Test func return_inserts_a_paragraph_after_the_block() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        let newId = await model.insertParagraph(after: "block-1")

        let edit = editor.edits.withLock { $0.first }
        guard case let .insertParagraph(afterBlockId, text, newBlockId) = edit else {
            Issue.record("expected an insertParagraph, got \(String(describing: edit))")
            return
        }
        #expect(afterBlockId == "block-1")
        #expect(text == "")
        #expect(newBlockId == newId)
        #expect(newId?.isEmpty == false)
    }

    /// **Absent, not disabled.** With no editor there is nothing to write
    /// through, so the surface must not offer a keyboard that cannot save.
    @Test func a_note_with_no_editor_cannot_be_edited_at_all() async {
        let model = NoteEditorViewModel(noteId: "note-1", editor: nil)
        #expect(!model.canEdit)

        await model.commit("text", for: "block-1", current: "other")
        #expect(model.status == .idle, "a read-only note must not report a failure")

        let inserted = await model.insertParagraph(after: nil)
        #expect(inserted == nil)
    }

    /// The draft is what the block shows once the user has touched it, and
    /// the document's text before that.
    @Test func a_block_shows_its_draft_once_it_has_one() {
        let model = NoteEditorViewModel(noteId: "note-1", editor: ScriptedEditor())

        #expect(model.text(for: "block-1", fallback: "from the document") == "from the document")
        model.draft("being typed", for: "block-1")
        #expect(model.text(for: "block-1", fallback: "from the document") == "being typed")
    }

    // MARK: - Block boundaries (N501)

    /// Enter in the middle of a block splits it: the head stays, the tail
    /// becomes a new block below.
    @Test func enter_in_the_middle_splits_a_block() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        let newId = await model.split("block-1", at: 5, text: "hello world")

        let edits = editor.edits.withLock { $0 }
        #expect(edits.count == 2)

        // **The tail is written before the head is truncated.** A failure
        // between the two leaves the text duplicated, which the user can see
        // and fix; the other order loses it.
        guard case let .insertParagraph(after, tail, inserted) = edits[0] else {
            Issue.record("expected the insert first, got \(edits[0])")
            return
        }
        #expect(after == "block-1")
        #expect(tail == " world")
        #expect(inserted == newId)

        guard case let .setText(blockId, head) = edits[1] else {
            Issue.record("expected the truncation second, got \(edits[1])")
            return
        }
        #expect(blockId == "block-1")
        #expect(head == "hello")
    }

    /// Enter at the very end is a split with an empty tail, which is how a
    /// new empty paragraph appears below.
    @Test func enter_at_the_end_leaves_the_text_alone() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.split("block-1", at: 5, text: "hello")

        let edits = editor.edits.withLock { $0 }
        guard case let .insertParagraph(_, tail, _) = edits[0] else {
            Issue.record("expected an insert")
            return
        }
        #expect(tail == "")
    }

    /// Backspace at offset zero merges a block into the one above, and the
    /// caret lands where the join happened.
    @Test func backspace_at_the_start_merges_into_the_block_above() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        let caret = await model.merge(
            "block-2", into: "block-1", text: "second", previousText: "first "
        )

        #expect(caret == 6, "the caret sits at the join, not at either end")

        let edits = editor.edits.withLock { $0 }
        #expect(edits.count == 2)
        // The join is written before the block is removed, for the same
        // reason the split writes the tail first.
        guard case let .setText(joinedId, joined) = edits[0] else {
            Issue.record("expected the join first, got \(edits[0])")
            return
        }
        #expect(joinedId == "block-1")
        #expect(joined == "first second")

        guard case let .delete(deleted) = edits[1] else {
            Issue.record("expected the delete second, got \(edits[1])")
            return
        }
        #expect(deleted == "block-2")
    }

    /// A failed merge must not have deleted the block whose text failed to
    /// move: that would be the one outcome worse than doing nothing.
    @Test func a_failed_merge_never_reaches_the_delete() async {
        let editor = ScriptedEditor(failure: CrdtError.DocumentBusy(docId: "d", what: "w"))
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        let caret = await model.merge(
            "block-2", into: "block-1", text: "second", previousText: "first "
        )

        #expect(caret == nil)
        let edits = editor.edits.withLock { $0 }
        #expect(edits.count == 1, "the delete must not run after the join failed")
        if case .delete = edits[0] {
            Issue.record("the block was deleted despite the join failing")
        }
    }

    // MARK: - Turning a block into another (N503)

    /// "Heading 2" is one choice to the user and two operations here, so the
    /// level rides along rather than leaving a heading at level 1.
    @Test func turning_into_a_heading_carries_its_level() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.turnInto("block-1", kind: "heading", level: 2)

        let edits = editor.edits.withLock { $0 }
        #expect(edits.count == 2)
        guard case let .turnInto(_, kind) = edits[0] else {
            Issue.record("expected a turnInto")
            return
        }
        #expect(kind == "heading")
        guard case let .setProp(_, name, value) = edits[1] else {
            Issue.record("expected a setProp")
            return
        }
        #expect(name == "level")
        #expect(value == "2")
    }

    /// A type with no level sends one operation, not a spurious prop write.
    @Test func turning_into_a_plain_type_sends_one_operation() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.turnInto("block-1", kind: "quote")

        #expect(editor.count == 1)
    }

    // MARK: - Marks (N504)

    /// A mark is addressed by range, which is what lets a toolbar format a
    /// selection without replacing the block and losing every other mark.
    @Test func formatting_a_selection_addresses_its_range() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.mark("block-1", from: 0, to: 5, "bold")
        await model.mark("block-1", from: 6, to: 11, "textColor", value: "red")

        let edits = editor.edits.withLock { $0 }
        guard case let .setMark(_, start, end, mark, value) = edits[0] else {
            Issue.record("expected a setMark")
            return
        }
        #expect(start == 0 && end == 5 && mark == "bold" && value == nil)

        guard case let .setMark(_, _, _, colour, colourValue) = edits[1] else {
            Issue.record("expected a setMark")
            return
        }
        #expect(colour == "textColor" && colourValue == "red")
    }

    // MARK: - Tables (N505)

    /// A cell is addressed by table plus row and column, because a cell has
    /// no id of its own (Q1).
    @Test func a_cell_is_addressed_by_its_position() async {
        let editor = ScriptedEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.setCell("table-1", row: 2, column: 1, text: "edited")
        await model.insertRow("table-1", at: 3)
        await model.deleteColumn("table-1", at: 0)

        let edits = editor.edits.withLock { $0 }
        guard case let .setCellText(tableId, row, column, text) = edits[0] else {
            Issue.record("expected a setCellText")
            return
        }
        #expect(tableId == "table-1" && row == 2 && column == 1 && text == "edited")

        guard case let .insertRow(_, at) = edits[1] else {
            Issue.record("expected an insertRow")
            return
        }
        #expect(at == 3)

        guard case let .deleteColumn(_, column) = edits[2] else {
            Issue.record("expected a deleteColumn")
            return
        }
        #expect(column == 0)
    }
}

@Suite("N509 undo over the operations the shell issued")
@MainActor
struct EditorUndoTests {

    /// Undo returns the step that reverses what was done, and moves it where
    /// redo can find it.
    @Test func undo_yields_the_reversing_operation() {
        let stack = EditorUndoStack()
        stack.record(.text(blockId: "b1", from: "before", to: "after"))

        #expect(stack.canUndo)
        #expect(!stack.canRedo)

        let step = stack.popUndo()
        guard case let .setText(id, text) = step?.backward else {
            Issue.record("expected a setText backward")
            return
        }
        #expect(id == "b1")
        #expect(text == "before", "undo must restore what was there before")
        #expect(stack.canRedo)
        #expect(!stack.canUndo)
    }

    /// Redo replays the forward operation.
    @Test func redo_replays_what_was_undone() {
        let stack = EditorUndoStack()
        stack.record(.text(blockId: "b1", from: "before", to: "after"))
        _ = stack.popUndo()

        let step = stack.popRedo()
        guard case let .setText(_, text) = step?.forward else {
            Issue.record("expected a setText forward")
            return
        }
        #expect(text == "after")
        #expect(stack.canUndo)
        #expect(!stack.canRedo)
    }

    /// **A new edit clears the redo stack.** The future redo pointed at no
    /// longer follows from the present, and replaying it would apply to a
    /// document that has since diverged.
    @Test func a_new_edit_discards_the_redo_future() {
        let stack = EditorUndoStack()
        stack.record(.text(blockId: "b1", from: "a", to: "b"))
        _ = stack.popUndo()
        #expect(stack.canRedo)

        stack.record(.text(blockId: "b2", from: "c", to: "d"))

        #expect(!stack.canRedo, "the old future must not survive a new edit")
        #expect(stack.canUndo)
    }

    /// Bounded, because an unbounded stack on a long session is a slow leak
    /// on the devices least able to afford it.
    @Test func the_stack_is_bounded() {
        let stack = EditorUndoStack(limit: 3)
        for index in 0..<10 {
            stack.record(.text(blockId: "b\(index)", from: "", to: "x"))
        }
        #expect(stack.undoable.count == 3)
        // The most recent survive, not the oldest.
        guard case let .setText(id, _) = stack.undoable.last?.forward else {
            Issue.record("expected a setText")
            return
        }
        #expect(id == "b9")
    }

    /// The affordance says what it will undo rather than only "Undo".
    @Test func the_stack_names_what_it_will_undo() {
        let stack = EditorUndoStack()
        #expect(stack.undoName == nil)
        stack.record(.turnInto(blockId: "b1", from: "paragraph", to: "heading"))
        #expect(stack.undoName == "Turn into")
    }

    /// Closing the note forgets the history, which would otherwise undo into
    /// a document the user is no longer looking at.
    @Test func closing_the_note_forgets_the_history() {
        let stack = EditorUndoStack()
        stack.record(.text(blockId: "b1", from: "a", to: "b"))
        _ = stack.popUndo()

        stack.clear()

        #expect(!stack.canUndo)
        #expect(!stack.canRedo)
    }

    /// A mark step is reversed by removing the mark over the same range.
    @Test func a_mark_is_undone_over_the_range_it_covered() {
        let step = EditorUndoStep.mark(
            blockId: "b1", start: 2, end: 7, mark: "bold", value: nil
        )
        guard case let .removeMark(id, start, end, mark) = step.backward else {
            Issue.record("expected a removeMark")
            return
        }
        #expect(id == "b1" && start == 2 && end == 7 && mark == "bold")
    }

    /// An insert is undone by deleting exactly the block that was inserted.
    @Test func an_insert_is_undone_by_deleting_what_it_made() {
        let step = EditorUndoStep.insert(
            blockId: "new-1", after: "b1", kind: "quote", text: "said"
        )
        guard case let .delete(id) = step.backward else {
            Issue.record("expected a delete")
            return
        }
        #expect(id == "new-1")
    }
}
