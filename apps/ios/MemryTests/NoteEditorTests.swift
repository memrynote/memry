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
}
