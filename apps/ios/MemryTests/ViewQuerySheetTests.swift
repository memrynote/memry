import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

private final class RecordingViewEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

/// The View row writes nothing until the sheet's Done, then one `memry-view`
/// code block that a single undo removes; an existing view's Done replaces
/// its fence in place.
@MainActor
struct ViewQuerySheetTests {
    private func done(_ session: EditorSession, _ text: String) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.saveView(text)
        }
    }

    @Test func doneInsertsAViewCodeBlockAndUndoRemovesIt() async throws {
        let editor = RecordingViewEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let fence = try #require(ViewQueryDraft.starter.fenceText)

        session.requestView()
        #expect(editor.all.isEmpty, "the sheet writes nothing until Done")
        await done(session, fence)

        guard case let .insertBlock(kind, after, text, newId) = editor.all.first else {
            Issue.record("expected an insert first, got \(editor.all)")
            return
        }
        #expect(kind == "codeBlock")
        #expect(after == nil)
        #expect(text == fence)
        #expect(Array(editor.all.dropFirst()) == [.setProp(blockId: newId, name: "language", value: "memry-view")])
        #expect(session.viewEdit == nil)

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.undo()
        }
        #expect(editor.all.last == .delete(blockId: newId))
    }

    @Test func cancelLeavesTheBodyAlone() {
        let editor = RecordingViewEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        model.session.model = model
        model.session.requestView()
        model.session.cancelViewEdit()
        model.session.saveView("{}")
        #expect(editor.all.isEmpty)
    }

    @Test func doneOnAnExistingViewReplacesItsFenceInPlace() async throws {
        let editor = RecordingViewEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let before = try #require(ViewQueryDraft.starter.fenceText)
        var draft = try #require(ViewQueryDraft(fence: before))
        draft.sourceKind = .tag
        draft.tag = "work"
        let after = try #require(draft.fenceText)

        session.editView(blockId: "v", text: before)
        await done(session, after)

        #expect(editor.all == [.replaceText(blockId: "v", text: after, base: nil)])
        #expect(session.history.popUndo()?.backward == .replaceText(blockId: "v", text: before))
    }
}
