import MemryCore
import Synchronization
import Testing
import UIKit
@testable import Memry

/// Records every edit, and the edits so far each time a page reads the note.
private final class LandingEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    private let landed = AsyncStream<Void>.makeStream()

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        landed.continuation.yield()
        return true
    }

    var all: [BlockEdit] { edits.withLock { $0 } }

    /// Returns once an edit has landed.
    func firstEdit() async {
        for await _ in landed.stream { return }
    }
}

/// #4457: an iPad window crossing compact and regular width draws the note
/// page again, and the caret goes back where it was.
@Suite("Editor focus across a re-host", .serialized)
@MainActor
struct EditorFocusMemoryTests {
    private let window: UIWindow = {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
        window.rootViewController = UIViewController()
        window.isHidden = false
        return window
    }()

    private func paragraph(_ text: String) -> Block {
        Block(
            id: "a", kind: "paragraph", depth: 0, props: [],
            inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
        )
    }

    /// A page for `noteId` as the note view builds it, sharing `memory`.
    private func page(
        _ noteId: String, _ editor: some BlockEditing, _ memory: EditorFocusMemory
    ) -> (NoteEditorViewModel, EditorSession) {
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        let session = model.session
        session.model = model
        session.focusMemory = memory
        return (model, session)
    }

    /// The block's text view, drawn into the window.
    private func draw(_ text: String, in session: EditorSession) -> BlockField {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: paragraph(text), session: session, style: style, alignment: .natural)
        field.textView.delegate = field
        field.textView.frame = CGRect(x: 0, y: 0, width: 300, height: 40)
        field.render()
        window.rootViewController?.view.addSubview(field.textView)
        return field
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @Test(.timeLimit(.minutes(1))) func a_redrawn_page_takes_back_the_caret_and_selection_its_block_had() async {
        let editor = LandingEditor()
        let memory = EditorFocusMemory()
        var (oldModel, oldSession): (NoteEditorViewModel?, EditorSession?) = page("note-1", editor, memory)
        _ = oldModel
        let old = draw("hello", in: oldSession!)
        #expect(old.textView.becomeFirstResponder())
        old.textView.text = "hello world"
        old.textViewDidChange(old.textView)
        old.textView.selectedRange = NSRange(location: 6, length: 5)

        // The shell re-hosts: the old page leaves the window and is dropped.
        old.textView.removeFromSuperview()
        (oldModel, oldSession) = (nil, nil)
        #expect(!memory.titleMayAutofocus("note-1"), "the new note's title would take the caret back")

        // The new page read the note before the old page's write landed.
        let (newModel, newSession) = page("note-1", editor, memory)
        let new = draw("hello", in: newSession)
        var editsAtReload: [[BlockEdit]] = []
        newSession.reload = {
            editsAtReload.append(editor.all)
            // The page draws what it read, as `updateUIView` does.
            new.block = paragraph("hello world")
            new.render()
        }
        await until { new.textView.isFirstResponder }

        #expect(new.textView.isFirstResponder)
        #expect(new.textView.selectedRange == NSRange(location: 6, length: 5))
        #expect(editsAtReload.first == [.setText(blockId: "a", text: "hello world")], "the page re-reads the typing first")
        #expect(memory.titleMayAutofocus("note-1"))
        new.textView.resignFirstResponder()
        new.textView.removeFromSuperview()
        _ = newModel
    }

    @Test(.timeLimit(.minutes(1))) func a_remembered_caret_stays_out_of_another_note_and_expires() async {
        let editor = LandingEditor()
        let memory = EditorFocusMemory()
        var clock = Date(timeIntervalSince1970: 0)
        memory.now = { clock }
        let (oldModel, oldSession) = page("note-1", editor, memory)
        let old = draw("hello", in: oldSession)
        #expect(old.textView.becomeFirstResponder())
        old.textView.removeFromSuperview()

        let (otherModel, otherSession) = page("note-2", editor, memory)
        var reloads = 0
        otherSession.reload = { reloads += 1 }
        let other = draw("hello", in: otherSession)
        for _ in 0..<20 { await Task.yield() }

        #expect(!other.textView.isFirstResponder)
        #expect(reloads == 0)
        #expect(!memory.titleMayAutofocus("note-1"))
        clock += EditorFocusMemory.lifetime + 1
        #expect(memory.titleMayAutofocus("note-1"), "a page the user comes back to later opens as usual")
        other.textView.removeFromSuperview()
        _ = (oldModel, otherModel)
    }

    /// The caret moving on, or the keyboard going away, is not a re-host:
    /// a block that leaves the window later remembers nothing.
    @Test func a_block_left_after_its_editing_ended_remembers_nothing() async {
        let memory = EditorFocusMemory()
        let (model, session) = page("note-1", LandingEditor(), memory)
        let field = draw("hello", in: session)
        #expect(field.textView.becomeFirstResponder())
        field.textView.resignFirstResponder()
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }

        field.textView.removeFromSuperview()

        #expect(memory.titleMayAutofocus("note-1"))
        _ = model
    }

    /// REVIEW-4494: the queued write held the model weakly, so a page torn
    /// down before it ran (a split view swapping notes) lost its typing.
    @Test(.timeLimit(.minutes(1))) func a_commit_lands_after_its_page_drops_the_model() async {
        let editor = LandingEditor()
        var model: NoteEditorViewModel? = NoteEditorViewModel(noteId: "note-1", editor: editor)
        model?.session.model = model
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: paragraph("hello"), session: model!.session, style: style, alignment: .natural)
        field.render()
        field.textView.text = "hello world"
        field.dirty = true

        field.session?.commit(field)
        model = nil
        await editor.firstEdit()

        #expect(editor.all == [.setText(blockId: "a", text: "hello world")])
    }

    /// A checklist line typed in and swapped away with its page (#4494's
    /// dismantle commit) becomes a task, as one the caret leaves does.
    @Test(.timeLimit(.minutes(1))) func a_typed_checklist_line_swapped_away_becomes_a_task() async {
        let (model, session) = page("note-1", LandingEditor(), EditorFocusMemory())
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let line = Block(
            id: "a", kind: "checkListItem", depth: 0, props: [],
            inline: [InlineRun(text: "buy", marks: [], markAttrs: [:], target: nil)]
        )
        let field = BlockField(block: line, session: session, style: style, alignment: .natural)
        field.render()
        field.textView.text = "buy milk"
        field.textViewDidChange(field.textView)

        let converted = await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
            session.convertTypedChecklist = { done.resume(returning: $0) }
            EditableBlockView.dismantleUIView(field.textView, coordinator: field)
        }

        #expect(converted == "a")
        _ = model
    }
}
