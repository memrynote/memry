//
//  EditorReturnBurstTests.swift
//  #4692: keys typed right after Return, before the new block takes the
//  caret, go into the new block in order. DATA-LOSS: they landed in the
//  previous block and were saved there.
//

import Foundation
import MemryCore
import Synchronization
import SwiftUI
import Testing
import UIKit

@testable import Memry

/// A note body held in memory, applying the edits the editor sends.
private final class BodyEditor: BlockEditing, @unchecked Sendable {
    let blocks: Mutex<[Block]>

    init(_ blocks: [Block]) { self.blocks = Mutex(blocks) }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        blocks.withLock { blocks in
            switch edit {
            case let .setText(blockId, text), let .replaceText(blockId, text, _):
                update(&blocks, blockId) { $0.inline = Self.runs(text) }
            case let .insertBlock(kind, after, text, newId):
                let index = blocks.firstIndex { $0.id == after }.map { $0 + 1 } ?? blocks.count
                blocks.insert(Block(id: newId, kind: kind, depth: 0, props: [], inline: Self.runs(text)), at: index)
            case let .delete(blockId):
                blocks.removeAll { $0.id == blockId }
            case let .setProp(blockId, name, value):
                update(&blocks, blockId) { $0.props.append(BlockProp(name: name, value: value)) }
            default:
                break
            }
        }
        return true
    }

    private static func runs(_ text: String) -> [InlineRun] {
        [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
    }

    private func update(_ blocks: inout [Block], _ id: String, _ change: (inout Block) -> Void) {
        guard let index = blocks.firstIndex(where: { $0.id == id }) else { return }
        change(&blocks[index])
    }

    var all: [Block] { blocks.withLock { $0 } }
    @MainActor var shown: [String] { all.map { BlockText.shown($0.inline) } }
}

@MainActor
@Observable
private final class Page {
    var blocks: [Block]
    init(_ blocks: [Block]) { self.blocks = blocks }
}

/// The note body as the page draws it: each block through `NoteBlockView`,
/// re-read from the editor after every write.
private struct Body: View {
    let page: Page
    let model: NoteEditorViewModel
    let editor: BodyEditor

    var body: some View {
        let bridge = NoteEditingBridge(model: model) { page.blocks = editor.all }
        VStack {
            ForEach(page.blocks, id: \.id) { block in
                NoteBlockView(block: block, editing: bridge)
            }
        }
    }
}

/// One note on screen in a key window, the caret at the end of its block.
@MainActor
private final class Screen {
    let editor: BodyEditor
    let model: NoteEditorViewModel
    let window: UIWindow

    init(_ kind: String = "paragraph", text: String) throws {
        let block = Block(id: "a", kind: kind, depth: 0, props: [], inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
        editor = BodyEditor([block])
        model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let page = Page([block])
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        window.rootViewController = UIHostingController(rootView: Body(page: page, model: model, editor: editor))
        window.makeKeyAndVisible()
    }

    func textViews(in view: UIView? = nil) -> [BlockTextView] {
        let view = view ?? window
        return (view as? BlockTextView).map { [$0] } ?? view.subviews.flatMap { textViews(in: $0) }
    }

    var focused: BlockTextView? { textViews().first { $0.isFirstResponder } }

    /// Waits for the first block's row, and puts the caret in it at `caret`
    /// (its end when `nil`).
    func start(caret: Int? = nil) async throws -> BlockTextView {
        for _ in 0 ..< 40 where textViews().isEmpty { try await Task.sleep(for: .milliseconds(25)) }
        let first = try #require(textViews().first)
        #expect(first.becomeFirstResponder())
        first.selectedRange = NSRange(location: caret ?? first.textStorage.length, length: 0)
        return first
    }

    /// Keys as the keyboard delivers them: to the first responder, through
    /// its delegate, then `insertText`, one key at a time with no run-loop
    /// turn between. (`insertText` alone does not ask the delegate.)
    func keys(_ text: String) {
        for character in text {
            guard let view = focused else {
                Issue.record("no text view holds the caret")
                return
            }
            let key = String(character)
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: key) != false {
                view.insertText(key)
            }
        }
    }

    /// Lets every queued write and redraw land, then ends editing, which
    /// commits the open block.
    func finish(blocks count: Int) async throws {
        for _ in 0 ..< 80 where editor.all.count < count || focused == nil {
            try await Task.sleep(for: .milliseconds(25))
        }
        try await Task.sleep(for: .milliseconds(200))
        focused?.resignFirstResponder()
        model.session.enqueue {}
        await model.session.tail?.value
    }
}

/// Serialized: each test takes the first responder of a key window.
@Suite(.serialized)
@MainActor
struct EditorReturnBurstTests {
    /// The issue's burst: `Alpha1`, Return, `Beta1` in one go.
    @Test(.timeLimit(.minutes(1))) func keysTypedRightAfterReturnLandInTheNewBlock() async throws {
        let screen = try Screen(text: "")
        defer { screen.window.isHidden = true }
        _ = try await screen.start()
        screen.keys("Alpha1\nBeta1")
        for _ in 0 ..< 80 where screen.focused?.text != "Beta1" { try await Task.sleep(for: .milliseconds(25)) }
        #expect(screen.focused?.text == "Beta1", "the caret went on with the keys")
        try await screen.finish(blocks: 2)
        #expect(screen.editor.shown == ["Alpha1", "Beta1"], "\(screen.editor.shown)")
    }

    /// Several Returns in one burst each make their block, in order.
    @Test(.timeLimit(.minutes(1))) func aBurstOfLinesMakesOneBlockPerLine() async throws {
        let screen = try Screen(text: "")
        defer { screen.window.isHidden = true }
        _ = try await screen.start()
        screen.keys("Alpha1\nBeta1\nAlpha2\nBeta2")
        try await screen.finish(blocks: 4)
        #expect(screen.editor.shown == ["Alpha1", "Beta1", "Alpha2", "Beta2"], "\(screen.editor.shown)")
    }

    /// A checklist item's Return makes a sibling item, which takes the keys.
    @Test(.timeLimit(.minutes(1))) func keysAfterReturnInAChecklistLandInTheNewItem() async throws {
        let screen = try Screen("checkListItem", text: "milk")
        defer { screen.window.isHidden = true }
        _ = try await screen.start()
        screen.keys("\neggs")
        try await screen.finish(blocks: 2)
        #expect(screen.editor.all.map(\.kind) == ["checkListItem", "checkListItem"])
        #expect(screen.editor.shown == ["milk", "eggs"], "\(screen.editor.shown)")
    }

    /// Return with the caret inside the text: the keys typed after it go to
    /// the new block, and the text around the caret stays whole.
    @Test(.timeLimit(.minutes(1))) func keysAfterAReturnMidTextLeaveTheTextWhole() async throws {
        let screen = try Screen(text: "headtail")
        defer { screen.window.isHidden = true }
        _ = try await screen.start(caret: 4)
        screen.keys("\nnew")
        try await screen.finish(blocks: 2)
        #expect(screen.editor.shown == ["headtail", "new"], "\(screen.editor.shown)")
    }

    /// An IME composition begun before the new block takes the caret moves
    /// there whole, converted as it stood.
    @Test(.timeLimit(.minutes(1))) func aCompositionBegunAfterReturnMovesToTheNewBlock() async throws {
        let screen = try Screen(text: "")
        defer { screen.window.isHidden = true }
        let first = try await screen.start()
        screen.keys("Alpha\n")
        first.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0))
        try await screen.finish(blocks: 2)
        #expect(screen.editor.shown == ["Alpha", "にほん"], "\(screen.editor.shown)")
    }

    /// Autocorrect sees the held keys as one word with the text before the
    /// Return and splits it ("Milkeggs" to "Milk eggs"). It never reaches
    /// back past the Return, so the new block gets no leading space.
    @Test(.timeLimit(.minutes(1))) func autocorrectionAcrossTheReturnIsRefused() async throws {
        let screen = try Screen(text: "")
        defer { screen.window.isHidden = true }
        let first = try await screen.start()
        screen.keys("Milk\neggs")
        let whole = NSRange(location: 0, length: first.textStorage.length)
        if first.delegate?.textView?(first, shouldChangeTextIn: whole, replacementText: "Milk eggs") != false {
            first.textStorage.replaceCharacters(in: whole, with: "Milk eggs")
        }
        try await screen.finish(blocks: 2)
        #expect(screen.editor.shown == ["Milk", "eggs"], "\(screen.editor.shown)")
    }

    /// Undo after the burst takes back the new block's typing first, then
    /// the block itself, and leaves the first block's text alone.
    @Test(.timeLimit(.minutes(1))) func undoAfterTheBurstTakesTheNewTypingThenTheBlock() async throws {
        let screen = try Screen(text: "")
        defer { screen.window.isHidden = true }
        _ = try await screen.start()
        screen.keys("Alpha1\nBeta1")
        for _ in 0 ..< 80 where screen.editor.all.count < 2 || screen.focused?.text != "Beta1" {
            try await Task.sleep(for: .milliseconds(25))
        }
        let session = screen.model.session
        #expect(screen.focused?.text == "Beta1")
        session.undo()
        #expect(screen.focused?.text == "", "the typing undo empties the new block")
        session.undo()
        session.enqueue {}
        await session.tail?.value
        #expect(screen.editor.shown == ["Alpha1"], "then the block goes, and the first keeps its text")
    }
}
