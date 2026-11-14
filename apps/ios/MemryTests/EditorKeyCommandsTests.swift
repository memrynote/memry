//
//  EditorKeyCommandsTests.swift
//  #4354: the editor's hardware keys, pressed on the block's text view, run
//  the session operation the toolbar runs and land in its undo history.
//

import Foundation
import MemryCore
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

    /// Blocks `a` and `b`, the caret in `focus`, `b` nested under `a` when
    /// `nested`. `text` is drawn in the focused block.
    init(focus: String = "b", nested: Bool = false, text: String = "hi", keyboard: Bool = true) {
        model = NoteEditorViewModel(noteId: "n1", editor: editor)
        session = model.session
        session.model = model
        session.hardwareKeyboard = HardwareKeyboard(attached: keyboard)
        let run = { (text: String) in [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)] }
        let blocks = [
            Block(id: "a", kind: "paragraph", depth: 0, props: [], inline: run(focus == "a" ? text : "top")),
            Block(id: "b", kind: "paragraph", depth: nested ? 1 : 0, props: [], inline: run(focus == "b" ? text : "below")),
        ]
        session.blocks = { blocks }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let block = blocks.first { $0.id == focus } ?? blocks[0]
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
            session.reload = {
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

    @Test func shiftCommandKAsksForALinkAndCommandKIsLeftToSearch() async {
        let page = Page()
        #expect(!page.has("k", .command), "⌘K is global search")
        page.field.textView.selectedRange = NSRange(location: 0, length: 2)
        page.session.selectionChanged(in: page.field)
        await page.press("k", [.command, .shift], writes: false)
        #expect(page.session.linkPrompt)
        await page.reloaded { page.session.addLink(" https://memry.app ") }
        #expect(page.editor.all.last == .setMark(blockId: "b", start: 0, end: 2, mark: "link", value: "https://memry.app"))
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
}
