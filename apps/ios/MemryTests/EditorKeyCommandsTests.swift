//
//  EditorKeyCommandsTests.swift
//  #4354: the editor's hardware keys, pressed on the block's text view, run
//  the session operation the toolbar runs and land in its undo history.
//

import Foundation
import MemryCore
import Observation
import Synchronization
import Testing
import UIKit

@testable import Memry

private final class RecordingEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

@MainActor
private final class Page {
    let editor = RecordingEditor()
    let model: NoteEditorViewModel
    let session: EditorSession
    let field: BlockField
    private let initial: Block

    /// Blocks `a` and `b`, the caret in `focus`, `b` nested under `a` when
    /// `nested`. `text` is drawn in the focused block, a `kind` block.
    init(focus: String = "b", nested: Bool = false, text: String = "hi", kind: String = "paragraph", keyboard: Bool = true) {
        model = NoteEditorViewModel(noteId: "n1", editor: editor)
        session = model.session
        session.model = model
        session.hardwareKeyboard = HardwareKeyboard(attached: keyboard)
        let run = { (text: String) in [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)] }
        let blocks = [
            Block(id: "a", kind: focus == "a" ? kind : "paragraph", depth: 0, props: [], inline: run(focus == "a" ? text : "top")),
            Block(id: "b", kind: focus == "b" ? kind : "paragraph", depth: nested ? 1 : 0, props: [], inline: run(focus == "b" ? text : "below")),
        ]
        session.blocks = { blocks }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let block = blocks.first { $0.id == focus } ?? blocks[0]
        initial = block
        field = BlockField(block: block, session: session, style: style, alignment: .natural)
        field.render()
        session.focusChanged(to: field)
    }

    /// Presses `input` with `modifiers` on the block's text view, and waits
    /// for the write it queues to reload the page.
    func press(_ input: String, _ modifiers: UIKeyModifierFlags = [], writes: Bool = true) async {
        guard let command = field.textView.keyCommands?.first(where: { $0.input == input && $0.modifierFlags == modifiers }) else {
            Issue.record("no key command for \(input) \(modifiers.rawValue)")
            return
        }
        guard writes else {
            field.textView.editorKey(command)
            return
        }
        await reloaded { field.textView.editorKey(command) }
    }

    /// Runs `work` and waits for the first page reload after it. A later one
    /// (a block another suite's window resigned commits too) is ignored.
    func reloaded(_ work: () -> Void) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            var waiting = true
            session.reload = { [self] in
                redraw()
                if waiting { done.resume() }
                waiting = false
            }
            work()
        }
    }

    /// The block in a key window with the caret, where UIKit registers its
    /// typing undo as it does on screen.
    func showInWindow() throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        field.textView.frame = CGRect(x: 0, y: 0, width: 300, height: 44)
        // As `makeUIView` sets it.
        field.textView.delegate = field
        window.rootViewController?.view.addSubview(field.textView)
        #expect(field.textView.becomeFirstResponder())
        field.textView.selectedRange = NSRange(location: field.textView.text.utf16.count, length: 0)
        return window
    }

    /// The core's copy of the focused block as the recorded writes leave it,
    /// drawn as `updateUIView` draws it: never over uncommitted typing.
    func redraw() {
        var text = BlockText.shown(initial.inline)
        var depth = initial.depth
        for edit in editor.all {
            switch edit {
            case let .setText(id, next) where id == field.blockId: text = next
            case let .replaceText(id, next, _) where id == field.blockId: text = next
            case let .indent(id) where id == field.blockId: depth += 1
            case let .outdent(id) where id == field.blockId: depth -= 1
            default: break
            }
        }
        let block = Block(id: initial.id, kind: initial.kind, depth: depth, props: [], inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
        guard block != field.block else { return }
        field.block = block
        if !field.dirty { field.render() }
    }

    /// Runs `work`, then waits for every write it queued, redrawing after.
    func settled(_ work: () -> Void) async {
        session.reload = { [self] in redraw() }
        work()
        session.enqueue {}
        await session.tail?.value
    }

    func has(_ input: String, _ modifiers: UIKeyModifierFlags = []) -> Bool {
        field.textView.keyCommands?.contains { $0.input == input && $0.modifierFlags == modifiers } ?? false
    }

    func type(_ text: String) {
        field.textView.text = text
        field.textView.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        field.textViewDidChange(field.textView)
    }
}

/// Serialized: the window tests take the first responder, which a parallel
/// test's block would resign, committing its typing mid-press.
@Suite(.serialized)
@MainActor
struct EditorKeyCommandsTests {
    @Test func tabNestsTheBlockAndShiftTabLiftsIt() async {
        let page = Page()
        await page.press("\t")
        #expect(page.editor.all.last == .indent(blockId: "b"))
        #expect(page.session.history.canUndo)

        let nested = Page(nested: true)
        await nested.press("\t", .shift)
        #expect(nested.editor.all.last == .outdent(blockId: "b"))
    }

    /// Desktop's code block: Tab types two spaces over the selection, as
    /// typing, and ⇧Tab still lifts the block.
    @Test func tabInACodeBlockTypesTwoSpacesAndShiftTabLiftsIt() async throws {
        let page = Page(kind: "codeBlock")
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        await page.press("\t", writes: false)
        #expect(page.field.textView.text == "hi  ")
        page.field.textView.selectedRange = NSRange(location: 0, length: 2)
        await page.press("\t", writes: false)
        #expect(page.field.textView.text == "    ")
        #expect(page.field.dirty, "the spaces are typing, committed like it")
        page.session.enqueue {}
        await page.session.tail?.value
        #expect(page.editor.all.isEmpty, "Tab did not nest the code block")

        let nested = Page(nested: true, kind: "codeBlock")
        await nested.press("\t", .shift)
        #expect(nested.editor.all.last == .outdent(blockId: "b"))
    }

    /// DATA-LOSS: an IME composition keeps the keyboard. Tab and ⌘B would
    /// commit the unconverted text and cancel the composition.
    @Test func noEditorKeysWhileMarkedTextIsPending() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        page.field.textView.selectedRange = NSRange(location: 0, length: 2)
        page.session.selectionChanged(in: page.field)
        page.field.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
        #expect(page.field.textView.markedTextRange != nil)
        #expect(!page.has("\t"))
        #expect(!page.has("b", .command))
        page.session.perform(.indent)
        page.session.perform(.bold)
        page.session.enqueue {}
        await page.session.tail?.value
        #expect(page.editor.all.isEmpty, "nothing committed")
        #expect(page.field.textView.markedTextRange != nil, "the composition is still open")
        #expect(!page.session.history.canUndo)
    }

    /// Nest, type, ⌘Z ⌘Z, then ⇧⌘Z ⇧⌘Z brings back the nest and then the
    /// typing; redo says so after every step.
    @Test func redoAfterABlockUndoRestoresTheTypingUndoneBeforeIt() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        await page.press("\t")
        #expect(!undo.canRedo)
        page.field.textView.insertText("!")
        try await Task.sleep(for: .milliseconds(50))
        #expect(!undo.canRedo)

        undo.undo()
        #expect(page.field.textView.text == "hi", "the first ⌘Z undoes the typing")
        #expect(undo.canRedo)
        await page.reloaded { undo.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"), "the second ⌘Z undoes the nest")
        #expect(undo.canRedo)

        await page.reloaded { undo.redo() }
        #expect(page.editor.all.last == .indent(blockId: "b"), "the first ⇧⌘Z redoes the nest")
        #expect(undo.canRedo)
        await page.reloaded { undo.redo() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "hi!"), "the second ⇧⌘Z redoes the typing")
        #expect(!undo.canRedo)
        #expect(undo.canUndo)
    }

    @Test func tabWhereTheCoreRefusesWritesNothing() async {
        let page = Page(focus: "a")
        await page.press("\t", writes: false)
        await page.press("\t", .shift, writes: false)
        page.session.enqueue {}
        await page.session.tail?.value
        #expect(page.editor.all.isEmpty)
        #expect(!page.session.history.canUndo)
    }

    @Test func tabWantsPriorityOverTheSystem() {
        let page = Page()
        let tab = page.field.textView.keyCommands?.first { $0.input == "\t" && $0.modifierFlags.isEmpty }
        #expect(tab?.wantsPriorityOverSystemBehavior == true)
    }

    /// ⌘Z and ⇧⌘Z reach the focused text view's undo manager, as the
    /// system sends them; it undoes through the session.
    @Test func systemUndoUndoesABlockStepAndRedoRedoesIt() async {
        let page = Page()
        await page.press("\t")
        #expect(page.field.textView.undoManager?.canUndo == true)
        await page.reloaded { page.field.textView.undoManager?.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"))
        #expect(page.field.textView.undoManager?.canRedo == true)
        await page.reloaded { page.field.textView.undoManager?.redo() }
        #expect(page.editor.all.last == .indent(blockId: "b"))
    }

    /// UIKit's own typing undo, with the block in a window: it registers
    /// where the session looks for it (`typingUndo`), not in the
    /// `BlockUndoManager` the text view answers with, and ⌘Z takes it
    /// before the block step under it.
    @Test func systemUndoTakesTypingBeforeABlockStep() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        await page.press("\t")
        page.field.textView.insertText("!")
        try await Task.sleep(for: .milliseconds(50))
        #expect(page.field.dirty)
        #expect(page.field.textView.typingUndo?.canUndo == true, "typing registered elsewhere")
        page.field.textView.undoManager?.undo()
        #expect(page.field.textView.text == "hi")
        #expect(page.editor.all.last == .indent(blockId: "b"), "the block step waits for the typing")
        #expect(page.session.history.canUndo)
    }

    /// DATA-LOSS: typing, then a nest, then ⌘Z twice undoes the nest and then
    /// the typing, never the other way round and never dropping the typing.
    @Test func systemUndoUndoesANestThenTheTypingBeforeIt() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        page.field.textView.insertText("!")
        try await Task.sleep(for: .milliseconds(50))
        await page.press("\t")
        #expect(page.editor.all == [.setText(blockId: "b", text: "hi!"), .indent(blockId: "b")])

        await page.reloaded { page.field.textView.undoManager?.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"), "the first ⌘Z undoes the nest")
        #expect(page.field.textView.text == "hi!", "the typing waits for the second ⌘Z")

        await page.reloaded { page.field.textView.undoManager?.undo() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "hi"), "the second ⌘Z undoes the typing")
        #expect(page.editor.all.count == 4)
    }

    /// DATA-LOSS (#4659): typing after a block undo is a new edit, which ends
    /// redo. ⇧⌘Z and the toolbar's Redo, both `EditorSession.redo`, do
    /// nothing: the typing stays and the nest is not put back.
    @Test(arguments: [true, false])
    func typingAfterABlockUndoEndsRedo(fromKeys: Bool) async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        await page.press("\t")
        await page.settled { undo.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"))
        #expect(page.session.canRedo)
        let redraws = Mutex(false)
        withObservationTracking { _ = page.session.canRedo } onChange: { redraws.withLock { $0 = true } }
        page.field.textView.insertText("x")
        try await Task.sleep(for: .milliseconds(50))
        #expect(!page.session.canRedo, "the toolbar's Redo is disabled")
        #expect(redraws.withLock { $0 }, "and the toolbars reading it redraw")
        #expect(!undo.canRedo)
        await page.settled { fromKeys ? undo.redo() : page.session.redo() }
        #expect(page.field.textView.text == "hix", "the typing is still on screen")
        #expect(page.editor.all.last == .outdent(blockId: "b"), "the nest is not put back")
        await page.settled { _ = page.field.textView.resignFirstResponder() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "hix"), "the typing is written")
        #expect(!page.session.history.canRedo)
    }

    /// DATA-LOSS (REVIEW-4693): redo after committed typing was undone and
    /// new typing started does not replay the old step over the new text.
    @Test(arguments: [true, false])
    func redoDoesNotReplayCommittedTypingOverNewTyping(fromKeys: Bool) async throws {
        let page = Page(text: "")
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        page.field.textView.insertText("hello")
        try await Task.sleep(for: .milliseconds(50))
        await page.settled { _ = page.field.textView.resignFirstResponder() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "hello"))
        #expect(page.field.textView.becomeFirstResponder())
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "")
        page.field.textView.insertText("world")
        try await Task.sleep(for: .milliseconds(50))
        #expect(!page.session.canRedo, "the toolbar's Redo is disabled")

        await page.settled { fromKeys ? undo.redo() : page.session.redo() }
        #expect(page.field.textView.text == "world")
        await page.settled { _ = page.field.textView.resignFirstResponder() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "world"), "the stored text")
        #expect(page.field.textView.text == "world")
        #expect(!page.session.history.canRedo)
        #expect(page.session.history.undoable.map(\.forward) == [.setText(blockId: "b", text: "world")])
    }

    /// DATA-LOSS (REVIEW-4693): typing with no UIKit typing undo left, after
    /// the `[[` storage edit: ⌘Z undoes that typing, not the nest before it.
    @Test func undoAfterAStorageEditUndoesTheTypingFirst() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        await page.press("\t")
        page.type("hi[")
        _ = page.field.textView(page.field.textView, shouldChangeTextIn: NSRange(location: 3, length: 0), replacementText: "[")
        #expect(page.field.textView.text == "hi[[]]")
        #expect(page.field.textView.typingUndo?.canUndo != true)
        #expect(undo.canUndo)

        await page.settled { undo.undo() }
        #expect(page.editor.all == [.indent(blockId: "b"), .setText(blockId: "b", text: "hi[[]]"), .setText(blockId: "b", text: "hi")])
        #expect(page.field.textView.text == "hi")
        await page.settled { undo.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"), "then the nest")
        #expect(!undo.canUndo)
    }

    /// After typing, a nest, its undo, new typing and a redo that does
    /// nothing, ⌘Z walks back newest first and ⇧⌘Z forward again, never
    /// putting back the nest the new typing ended.
    @Test func undoAndRedoKeepTheirOrderAfterNewTyping() async throws {
        let page = Page(text: "")
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        page.field.textView.insertText("a")
        try await Task.sleep(for: .milliseconds(50))
        await page.settled { _ = page.field.textView.resignFirstResponder() }
        #expect(page.field.textView.becomeFirstResponder())
        await page.press("\t")
        await page.settled { undo.undo() }
        page.field.textView.insertText("b")
        try await Task.sleep(for: .milliseconds(50))
        await page.settled { undo.redo() }
        #expect(page.field.textView.text == "ab")
        let outdented = page.editor.all.count

        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "a")
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "")
        #expect(!undo.canUndo)
        await page.settled { undo.redo() }
        #expect(page.field.textView.text == "a")
        await page.settled { undo.redo() }
        #expect(page.field.textView.text == "ab")
        #expect(!undo.canRedo)
        #expect(!page.editor.all[outdented...].contains(.indent(blockId: "b")), "the nest stays undone")
        await page.settled { _ = page.field.textView.resignFirstResponder() }
        #expect(page.editor.all.last == .setText(blockId: "b", text: "ab"))
    }

    /// An open IME composition: neither toolbar offers undo or redo, which
    /// would do nothing.
    @Test func noUndoOrRedoOfferedDuringAComposition() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        await page.press("\t")
        await page.settled { page.session.undo() }
        #expect(page.session.canUndo || page.session.canRedo)
        page.field.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
        #expect(!page.session.canUndo)
        #expect(!page.session.canRedo)
    }

    /// DATA-LOSS (#4659): a block undo or redo while an IME composition is
    /// pending waits: replaying would redraw the block and cancel it.
    @Test func blockUndoWaitsForAnIMEComposition() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        await page.press("\t")
        page.field.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
        await page.settled { undo.undo() }
        await page.settled { page.session.undo() }
        #expect(page.field.textView.markedTextRange != nil, "the composition is still open")
        #expect(page.field.textView.text == "hiに")
        #expect(page.editor.all.last == .indent(blockId: "b"), "nothing replayed")

        page.field.textView.unmarkText()
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "hi", "once confirmed, the composition is typing ⌘Z takes first")
        await page.settled { undo.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"), "then the nest")
    }

    /// DATA-LOSS (#4644): the window's typing undo keeps typing the session
    /// already committed as a history step. Typing after a block undo must
    /// not undo it along with the new typing, from before the replay.
    @Test func typingUndoAfterABlockUndoTakesOnlyTheNewTyping() async throws {
        let page = Page()
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        let undo = try #require(page.field.textView.undoManager)
        page.field.textView.insertText("!")
        try await Task.sleep(for: .milliseconds(50))
        await page.press("\t")
        await page.settled { undo.undo() }
        #expect(page.editor.all.last == .outdent(blockId: "b"))
        page.field.textView.insertText("?")
        try await Task.sleep(for: .milliseconds(50))

        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "hi!", "the first ⌘Z undoes only the typing since the replay")
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "hi", "the second undoes the committed typing, as a history step")
        #expect(page.editor.all.last == .setText(blockId: "b", text: "hi"))
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "hi")
        #expect(!undo.canUndo)

        // Per-block typing undo still works after the clean-up.
        // One insert: two, with a wait between, coalesce into one typing
        // undo only when the run loop is idle enough.
        page.field.textView.insertText("ab")
        try await Task.sleep(for: .milliseconds(50))
        #expect(undo.canUndo)
        await page.settled { undo.undo() }
        #expect(page.field.textView.text == "hi")
        await page.settled { undo.redo() }
        #expect(page.field.textView.text == "hiab")
    }

    /// Desktop's keys: ⌘B, ⌘I, ⌘U, ⇧⌘S and ⌘E.
    @Test(arguments: [
        ("b", "command", "bold"),
        ("i", "command", "italic"),
        ("u", "command", "underline"),
        ("s", "command shift", "strike"),
        ("e", "command", "code"),
    ])
    func formattingKeysMarkTheSelection(input: String, modifiers: String, mark: String) async {
        let page = Page()
        page.field.textView.selectedRange = NSRange(location: 0, length: 2)
        page.session.selectionChanged(in: page.field)
        await page.press(input, modifiers.contains("shift") ? [.command, .shift] : .command)
        #expect(page.editor.all.last == .setMark(blockId: "b", start: 0, end: 2, mark: mark, value: nil))
        #expect(page.session.history.canUndo)
    }

    /// #4667: the prompt is an alert over the page, so its field takes the
    /// keys, and Add links the selection the prompt opened over.
    @Test func shiftCommandKAsksForALinkAndCommandKIsLeftToSearch() async throws {
        let page = Page()
        #expect(!page.has("k", .command), "⌘K is global search")
        let window = try page.showInWindow()
        defer { window.isHidden = true }
        page.field.textView.selectedRange = NSRange(location: 0, length: 2)
        page.session.selectionChanged(in: page.field)
        await page.press("k", [.command, .shift], writes: false)
        let target = LinkPrompt.Target(blockId: "b", text: "hi", selection: NSRange(location: 0, length: 2))
        let alert = try #require(window.rootViewController?.presentedViewController as? UIAlertController)
        #expect(alert.title == "Link")
        #expect(alert.textFields?.count == 1)
        if let coordinator = alert.transitionCoordinator {
            await withCheckedContinuation { done in
                coordinator.animate(alongsideTransition: nil) { _ in done.resume() }
            }
        }
        #expect(alert.textFields?.first?.isFirstResponder == true, "the prompt's field has no caret")
        await withCheckedContinuation { done in alert.dismiss(animated: false) { done.resume() } }
        page.field.textView.selectedRange = NSRange(location: 2, length: 0)
        await page.reloaded {
            LinkPrompt.finish(" https://memry.app ", target: target, field: page.field, session: page.session)
        }
        #expect(page.field.textView.isFirstResponder)
        #expect(page.field.textView.text == "hi")
        #expect(page.editor.all.last == .setMark(blockId: "b", start: 0, end: 2, mark: "link", value: "https://memry.app"))
    }

    /// The block's text, or the block in its row, changed while the prompt
    /// was open: the saved range names other text, so Add links nothing,
    /// says so, and puts the caret back inside the text there is now.
    @Test(arguments: [("b", "x"), ("a", "hi there")])
    func addLinksNothingWhenTheBlockChangedUnderThePrompt(blockId: String, text: String) async {
        let page = Page(text: "hi there")
        let target = LinkPrompt.Target(blockId: "b", text: "hi there", selection: NSRange(location: 3, length: 5))
        page.field.block = Block(
            id: blockId, kind: "paragraph", depth: 0, props: [],
            inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
        )
        page.field.render()
        LinkPrompt.finish("https://memry.app", target: target, field: page.field, session: page.session)
        await page.session.tail?.value
        #expect(page.editor.all.isEmpty, "a link was written over changed text")
        #expect(page.session.failure == LinkPrompt.textChanged)
        let length = page.field.textView.textStorage.length
        #expect(NSMaxRange(page.field.textView.selectedRange) <= length)
        #expect(page.field.textView.text == text)
    }

    /// Cancel over shorter text puts the caret back clamped to it.
    @Test func cancelClampsTheCaretToTheTextThereIsNow() {
        let page = Page(text: "x")
        let target = LinkPrompt.Target(blockId: "b", text: "hi there", selection: NSRange(location: 3, length: 5))
        LinkPrompt.finish(nil, target: target, field: page.field, session: page.session)
        #expect(page.field.textView.selectedRange == NSRange(location: 1, length: 0))
        #expect(page.session.failure == nil)
        #expect(page.editor.all.isEmpty)
    }

    @Test func menuKeysExistOnlyOverAnOpenMenu() {
        let page = Page(text: "")
        #expect(!page.has(UIKeyCommand.inputDownArrow))
        #expect(!page.has(UIKeyCommand.inputEscape))
        page.type("/")
        #expect(page.session.menuOpen)
        #expect(page.has(UIKeyCommand.inputDownArrow))
        #expect(page.has(UIKeyCommand.inputUpArrow))
        #expect(page.has(UIKeyCommand.inputEscape))
        #expect(page.has(".", .command))
    }

    @Test func arrowsMoveTheHighlightAndReturnPicksIt() async {
        let page = Page(text: "")
        page.session.tags = ["work", "world"]
        page.type("#wo")
        #expect(page.session.tagSuggestions.map(\.tag).prefix(2) == ["work", "world"])
        await page.press(UIKeyCommand.inputDownArrow, writes: false)
        #expect(page.session.highlighted == 1)
        await page.press(UIKeyCommand.inputUpArrow, writes: false)
        await page.press(UIKeyCommand.inputUpArrow, writes: false)
        #expect(page.session.highlighted == page.session.tagSuggestions.count - 1, "↑ wraps to the last row")
        await page.press(UIKeyCommand.inputDownArrow, writes: false)
        await page.press(UIKeyCommand.inputDownArrow, writes: false)
        await page.reloaded {
            _ = page.field.textView(page.field.textView, shouldChangeTextIn: NSRange(location: 3, length: 0), replacementText: "\n")
        }
        let tag = page.editor.all.compactMap { edit -> String? in
            guard case let .insertInline(_, _, _, kind, _, attrs) = edit, kind == "hashTag" else { return nil }
            return attrs["tag"]
        }
        #expect(tag == ["world"])
    }

    /// The arrows moved the highlight, then the menu closed: with no
    /// hardware keyboard, Return over the next menu makes a block again.
    @Test func closingTheMenuForgetsTheArrows() async {
        let page = Page(text: "", keyboard: false)
        page.session.tags = ["work", "world"]
        page.type("#wo")
        await page.press(UIKeyCommand.inputDownArrow, writes: false)
        #expect(page.session.highlightMoved)
        page.type("")
        #expect(!page.session.menuOpen)
        #expect(!page.session.highlightMoved)
        page.type("#wo")
        #expect(!page.session.pickHighlighted())
    }

    @Test func returnOverATagMenuStillMakesABlockWithTheOnScreenKeyboard() {
        let page = Page(text: "", keyboard: false)
        page.session.tags = ["work"]
        page.type("#wo")
        #expect(page.session.menuOpen)
        #expect(!page.session.pickHighlighted())
    }

    @Test func escapeClosesTheMenuUntilTheCaretLeavesItsTrigger() async {
        let page = Page(text: "")
        page.type("/")
        await page.press(UIKeyCommand.inputEscape, writes: false)
        #expect(!page.session.menuOpen)
        page.type("/he")
        #expect(!page.session.menuOpen, "typing on in the closed trigger keeps it closed")
        page.type("/he ")
        page.type("/he /")
        #expect(page.session.menuOpen, "a new trigger opens again")
        await page.press(".", .command, writes: false)
        #expect(!page.session.menuOpen)
    }

    /// Esc closes one kind of menu: another trigger typed at the same place
    /// opens its own.
    @Test func escapeClosesOnlyThatTriggersMenu() async {
        let page = Page(text: "")
        page.session.tags = ["work"]
        page.type("/")
        await page.press(UIKeyCommand.inputEscape, writes: false)
        page.type("#wo")
        #expect(!page.session.tagSuggestions.isEmpty, "the # menu opened where the / menu was closed")
    }
}
