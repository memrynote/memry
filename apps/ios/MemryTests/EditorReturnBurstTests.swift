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
    /// What the core does with a new block: lands it, holds it until set
    /// back to `.land`, or refuses it.
    let inserts = Mutex(Inserts.land)
    /// The same for a block's text, which the core writes or holds.
    let texts = Mutex(Inserts.land)
    enum Inserts { case land, wait, refuse }
    struct Refused: Error {}

    init(_ blocks: [Block]) { self.blocks = Mutex(blocks) }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        if case .insertBlock = edit {
            while inserts.withLock({ $0 }) == .wait { try await Task.sleep(for: .milliseconds(10)) }
            if inserts.withLock({ $0 }) == .refuse { throw Refused() }
        }
        switch edit {
        case .setText, .replaceText:
            while texts.withLock({ $0 }) == .wait { try await Task.sleep(for: .milliseconds(10)) }
        default:
            break
        }
        return blocks.withLock { blocks in
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
            case let .turnInto(blockId, kind):
                update(&blocks, blockId) { $0.kind = kind }
            default:
                break
            }
            return true
        }
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

    /// The block typed in, then a paragraph for each of `below`.
    init(_ kind: String = "paragraph", depth: UInt32 = 0, text: String, below: [String] = []) throws {
        let block = Block(id: "a", kind: kind, depth: depth, props: [], inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
        let blocks = [block] + below.enumerated().map { index, text in
            Block(id: "b\(index)", kind: "paragraph", depth: 0, props: [], inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
        }
        editor = BodyEditor(blocks)
        model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let page = Page(blocks)
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        window.rootViewController = UIHostingController(rootView: Body(page: page, model: model, editor: editor))
        window.makeKeyAndVisible()
        observer = NotificationCenter.default.addObserver(
            forName: UIWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.interrupted = true }
        }
    }

    /// Another suite made its window key while this screen was up. Suites
    /// run in parallel in this process, and that takes the caret from the
    /// old block for a reason other than its Return's new block, which
    /// leaves the held keys where they were typed (by design).
    private(set) var interrupted = false
    private var observer: NSObjectProtocol?

    func close() {
        observer.map(NotificationCenter.default.removeObserver)
        window.isHidden = true
    }

    /// Runs `scenario` on a new screen until a run is not interrupted, and
    /// returns what it saw. An interrupted run proves nothing either way.
    static func run<T>(
        _ kind: String = "paragraph", depth: UInt32 = 0, text: String, below: [String] = [],
        _ scenario: (Screen) async throws -> T
    ) async throws -> T {
        var attempt = 0
        while true {
            attempt += 1
            let screen = try Screen(kind, depth: depth, text: text, below: below)
            defer { screen.close() }
            let seen = try await scenario(screen)
            if !screen.interrupted || attempt == 10 { return seen }
            print("EditorReturnBurstTests: another suite took the caret, run \(attempt) discarded")
            // The other suite types for a while: wait it out.
            try await Task.sleep(for: .milliseconds(200 * attempt))
        }
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
                if !interrupted { Issue.record("no text view holds the caret") }
                return
            }
            let key = String(character)
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: key) != false {
                view.insertText(key)
            }
        }
    }

    /// Backspace as the keyboard delivers it: through the delegate, then
    /// `deleteBackward`, which at the block's start asks no delegate.
    func backspace() {
        guard let view = focused else {
            Issue.record("no text view holds the caret")
            return
        }
        let caret = view.selectedRange
        let range = caret.length > 0 || caret.location == 0 ? caret : NSRange(location: caret.location - 1, length: 1)
        if range.length == 0 || view.delegate?.textView?(view, shouldChangeTextIn: range, replacementText: "") != false {
            view.deleteBackward()
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

/// What the old row saw as it left the window.
@MainActor
private final class Seen {
    var held: Bool?
}

/// Serialized: each test takes the first responder of a key window.
@Suite(.serialized)
@MainActor
struct EditorReturnBurstTests {
    /// The issue's burst: `Alpha1`, Return, `Beta1` in one go.
    @Test(.timeLimit(.minutes(1))) func keysTypedRightAfterReturnLandInTheNewBlock() async throws {
        let (caret, shown) = try await Screen.run(text: "") { screen in
            _ = try await screen.start()
            screen.keys("Alpha1\nBeta1")
            for _ in 0 ..< 80 where screen.focused?.text != "Beta1" { try await Task.sleep(for: .milliseconds(25)) }
            let caret = screen.focused?.text
            try await screen.finish(blocks: 2)
            return (caret, screen.editor.shown)
        }
        #expect(caret == "Beta1", "the caret went on with the keys")
        #expect(shown == ["Alpha1", "Beta1"], "\(shown)")
    }

    /// Several Returns in one burst each make their block, in order.
    @Test(.timeLimit(.minutes(1))) func aBurstOfLinesMakesOneBlockPerLine() async throws {
        let shown = try await Screen.run(text: "") { screen in
            _ = try await screen.start()
            screen.keys("Alpha1\nBeta1\nAlpha2\nBeta2")
            try await screen.finish(blocks: 4)
            return screen.editor.shown
        }
        #expect(shown == ["Alpha1", "Beta1", "Alpha2", "Beta2"], "\(shown)")
    }

    /// A checklist item's Return makes a sibling item, which takes the keys.
    @Test(.timeLimit(.minutes(1))) func keysAfterReturnInAChecklistLandInTheNewItem() async throws {
        let blocks = try await Screen.run("checkListItem", text: "milk") { screen in
            _ = try await screen.start()
            screen.keys("\neggs")
            try await screen.finish(blocks: 2)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == ["checkListItem", "checkListItem"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["milk", "eggs"])
    }

    /// Return with the caret inside the text: the keys typed after it go to
    /// the new block, and the text around the caret stays whole.
    @Test(.timeLimit(.minutes(1))) func keysAfterAReturnMidTextLeaveTheTextWhole() async throws {
        let shown = try await Screen.run(text: "headtail") { screen in
            _ = try await screen.start(caret: 4)
            screen.keys("\nnew")
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["headtail", "new"], "\(shown)")
    }

    /// An IME composition begun before the new block takes the caret moves
    /// there whole, converted as it stood.
    @Test(.timeLimit(.minutes(1))) func aCompositionBegunAfterReturnMovesToTheNewBlock() async throws {
        let shown = try await Screen.run(text: "") { screen in
            let first = try await screen.start()
            screen.keys("Alpha\n")
            first.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0))
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["Alpha", "にほん"], "\(shown)")
    }

    /// Autocorrect sees the held keys as one word with the text before the
    /// Return and splits it ("Milkeggs" to "Milk eggs"). It never reaches
    /// back past the Return, so the new block gets no leading space.
    @Test(.timeLimit(.minutes(1))) func autocorrectionAcrossTheReturnIsRefused() async throws {
        let shown = try await Screen.run(text: "") { screen in
            let first = try await screen.start()
            screen.keys("Milk\neggs")
            let whole = NSRange(location: 0, length: first.textStorage.length)
            if first.delegate?.textView?(first, shouldChangeTextIn: whole, replacementText: "Milk eggs") != false {
                first.textStorage.replaceCharacters(in: whole, with: "Milk eggs")
            }
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["Milk", "eggs"], "\(shown)")
    }

    /// Undo after the burst takes back the new block's typing first, then
    /// the block itself, and leaves the first block's text alone.
    @Test(.timeLimit(.minutes(1))) func undoAfterTheBurstTakesTheNewTypingThenTheBlock() async throws {
        let (typed, afterTypingUndo, shown) = try await Screen.run(text: "") { screen in
            _ = try await screen.start()
            screen.keys("Alpha1\nBeta1")
            for _ in 0 ..< 80 where screen.editor.all.count < 2 || screen.focused?.text != "Beta1" {
                try await Task.sleep(for: .milliseconds(25))
            }
            let session = screen.model.session
            let typed = screen.focused?.text
            session.undo()
            let afterTypingUndo = screen.focused?.text
            session.undo()
            session.enqueue {}
            await session.tail?.value
            return (typed, afterTypingUndo, screen.editor.shown)
        }
        #expect(typed == "Beta1")
        #expect(afterTypingUndo == "", "the typing undo empties the new block")
        #expect(shown == ["Alpha1"], "then the block goes, and the first keeps its text")
    }

    // MARK: Return on an empty list item (#4704)

    /// Return on an empty list item turns it into a paragraph, nested or
    /// not (desktop's `listItemEnterHandler`), and the redrawn row takes the
    /// caret: keys typed once it is drawn land in it.
    @Test(.timeLimit(.minutes(1)), arguments: [
        ("checkListItem", 0 as UInt32), ("bulletListItem", 0), ("numberedListItem", 0), ("checkListItem", 1),
    ])
    func keysTypedAfterAListExitLandInTheParagraph(kind: String, depth: UInt32) async throws {
        let blocks = try await Screen.run(kind, depth: depth, text: "") { screen in
            let item = try await screen.start()
            screen.keys("\n")
            for _ in 0 ..< 80 where screen.editor.all.first?.kind != "paragraph" || screen.textViews().contains(item) {
                try await Task.sleep(for: .milliseconds(25))
            }
            try await Task.sleep(for: .milliseconds(200))
            screen.keys("abc")
            try await screen.finish(blocks: 1)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == ["paragraph"])
        #expect(blocks.map(\.depth) == [depth])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["abc"])
    }

    /// The same keys typed in one burst with the Return, before the row is
    /// redrawn, land in the paragraph too.
    @Test(.timeLimit(.minutes(1))) func keysTypedInABurstWithAListExitLandInTheParagraph() async throws {
        let (caret, blocks) = try await Screen.run("checkListItem", text: "") { screen in
            let item = try await screen.start()
            screen.keys("\nabc")
            for _ in 0 ..< 80 where screen.textViews().contains(item) || screen.focused?.text != "abc" {
                try await Task.sleep(for: .milliseconds(25))
            }
            let caret = screen.focused?.text
            try await screen.finish(blocks: 1)
            return (caret, screen.editor.all)
        }
        #expect(caret == "abc", "the redrawn row holds the caret and the keys")
        #expect(blocks.map(\.kind) == ["paragraph"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["abc"])
    }

    /// The redrawn row holds the caret as the old row leaves the window, in
    /// that turn, so no key arrives while no text view holds it
    /// (REVIEW-4714 M1).
    @Test(.timeLimit(.minutes(1))) func theRedrawnRowHoldsTheCaretAsTheOldOneLeaves() async throws {
        let held = try await Screen.run("checkListItem", text: "") { screen in
            let item = try await screen.start()
            let seen = Seen()
            let moved = item.movedToWindow
            item.movedToWindow = { window in
                moved?(window)
                if window == nil, seen.held == nil { seen.held = screen.focused != nil }
            }
            screen.keys("\n")
            for _ in 0 ..< 80 where seen.held == nil { try await Task.sleep(for: .milliseconds(25)) }
            return seen.held
        }
        #expect(held == true, "a text view holds the caret as the old row leaves")
    }

    /// A second Return while the item turns into a paragraph is a
    /// paragraph's Return: a new paragraph below takes the keys after it, as
    /// on desktop, and the item is turned once (REVIEW-4714 M2). The row is
    /// redrawn before or after the new block lands.
    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func aSecondReturnDuringAListExitMakesAParagraphBelow(redrawFirst: Bool) async throws {
        let (blocks, steps) = try await Screen.run("checkListItem", text: "") { screen in
            let item = try await screen.start()
            if redrawFirst { screen.editor.inserts.withLock { $0 = .wait } }
            screen.keys("\n\nabc")
            for _ in 0 ..< 80 where redrawFirst && screen.textViews().contains(item) {
                try await Task.sleep(for: .milliseconds(25))
            }
            screen.editor.inserts.withLock { $0 = .land }
            for _ in 0 ..< 80 where screen.focused?.text != "abc" { try await Task.sleep(for: .milliseconds(25)) }
            try await screen.finish(blocks: 2)
            return (screen.editor.all, screen.model.session.history.undoable)
        }
        #expect(blocks.map(\.kind) == ["paragraph", "paragraph"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["", "abc"])
        #expect(!steps.contains { $0.forward == $0.backward }, "no undo step that changes nothing")
    }

    /// Keys typed after the row is redrawn, and before the new block lands,
    /// go to the new block after the ones the old row held, in order, a
    /// Return among them included (REVIEW-4714 M3). In the other order the
    /// new block lands before the redraw.
    @Test(.timeLimit(.minutes(1)), arguments: [
        (true, "def", ["", "abcdef"]), (true, "def\ngh", ["", "abcdef", "gh"]),
        (false, "def", ["", "abcdef"]), (false, "def\ngh", ["", "abcdef", "gh"]),
    ])
    func keysTypedAfterTheRedrawFollowTheHeldOnes(redrawFirst: Bool, later: String, expected: [String]) async throws {
        let blocks = try await Screen.run("checkListItem", text: "") { screen in
            let item = try await screen.start()
            if redrawFirst { screen.editor.inserts.withLock { $0 = .wait } }
            screen.keys("\n\nabc")
            for _ in 0 ..< 80 where screen.textViews().contains(item) || screen.focused == nil {
                try await Task.sleep(for: .milliseconds(25))
            }
            if !redrawFirst {
                for _ in 0 ..< 80 where screen.focused?.text != "abc" { try await Task.sleep(for: .milliseconds(25)) }
            }
            screen.keys(later)
            screen.editor.inserts.withLock { $0 = .land }
            try await screen.finish(blocks: expected.count)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == expected.map { _ in "paragraph" })
        #expect(blocks.map { BlockText.shown($0.inline) } == expected, "\(blocks.map { BlockText.shown($0.inline) })")
    }

    /// The core refuses the new block after the row was redrawn: the keys
    /// typed before and after the redraw stay in the paragraph, in order.
    @Test(.timeLimit(.minutes(1))) func aRefusedBlockAfterTheRedrawKeepsEveryKey() async throws {
        let blocks = try await Screen.run("checkListItem", text: "") { screen in
            let item = try await screen.start()
            screen.editor.inserts.withLock { $0 = .wait }
            screen.keys("\n\nabc")
            for _ in 0 ..< 80 where screen.textViews().contains(item) || screen.focused == nil {
                try await Task.sleep(for: .milliseconds(25))
            }
            screen.keys("def")
            screen.editor.inserts.withLock { $0 = .refuse }
            for _ in 0 ..< 80 where screen.model.session.returnBurst != nil { try await Task.sleep(for: .milliseconds(25)) }
            screen.keys("g")
            try await screen.finish(blocks: 1)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == ["paragraph"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["abcdefg"], "\(blocks.map { BlockText.shown($0.inline) })")
    }

    /// Text typed into the item as it turns into a paragraph stays there, and
    /// a Return after it makes a paragraph that takes the rest.
    @Test(.timeLimit(.minutes(1))) func linesTypedDuringAListExitStayParagraphs() async throws {
        let (blocks, steps) = try await Screen.run("checkListItem", text: "") { screen in
            _ = try await screen.start()
            screen.keys("\nab\ncd")
            for _ in 0 ..< 80 where screen.focused?.text != "cd" { try await Task.sleep(for: .milliseconds(25)) }
            try await screen.finish(blocks: 2)
            return (screen.editor.all, screen.model.session.history.undoable)
        }
        #expect(blocks.map(\.kind) == ["paragraph", "paragraph"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["ab", "cd"])
        #expect(!steps.contains { $0.forward == $0.backward }, "no undo step that changes nothing")
    }

    // MARK: A block shortcut, then a burst (#4720)

    /// The old row commits what it took as the redrawn row takes over, and
    /// the core echoes that text back only after a Return in the new row
    /// committed more. The echo is no news to the row: drawn, it put the
    /// older text back, and the next keys landed inside the item (`megilk`).
    /// The old row can commit more than once before it hands over (here,
    /// the app resigning active mid-word): no echo of either is drawn.
    @Test(.timeLimit(.minutes(1)), arguments: [
        ("[] ", "checkListItem", false), ("- ", "bulletListItem", false), ("1. ", "numberedListItem", false),
        ("[] ", "checkListItem", true),
    ])
    func theEchoOfATakenOverCommitLeavesNewerTypingAlone(shortcut: String, kind: String, twice: Bool) async throws {
        let blocks = try await Screen.run(text: "") { screen in
            let paragraph = try await screen.start()
            screen.editor.texts.withLock { $0 = .wait }
            screen.editor.inserts.withLock { $0 = .wait }
            screen.keys(shortcut + "mi")
            if twice { NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil) }
            screen.keys("l")
            for _ in 0 ..< 80 where screen.textViews().contains(paragraph) || screen.focused?.text != "mil" {
                try await Task.sleep(for: .milliseconds(25))
            }
            screen.keys("k\n")
            screen.editor.texts.withLock { $0 = .land }
            for _ in 0 ..< 80 where screen.editor.shown.first != "milk" { try await Task.sleep(for: .milliseconds(25)) }
            try await Task.sleep(for: .milliseconds(200))
            screen.keys("eggs\n")
            screen.editor.inserts.withLock { $0 = .land }
            try await screen.finish(blocks: 3)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == [kind, kind, kind])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["milk", "eggs", ""], "\(blocks.map { BlockText.shown($0.inline) })")
    }

    // MARK: Edits outside the held keys end the hold (REVIEW-4707 M1)

    /// Backspace past the Return deletes the text before it, as before #4692:
    /// the keys then stay in the old block, and nothing is lost.
    @Test(.timeLimit(.minutes(1))) func backspacePastTheReturnDeletesAndKeepsTheKeys() async throws {
        let shown = try await Screen.run(text: "") { screen in
            _ = try await screen.start()
            screen.keys("Alpha\n")
            screen.backspace()
            screen.keys("Beta")
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["AlphBeta", ""], "\(shown)")
    }

    /// Typing where an arrow moved the caret lands there.
    @Test(.timeLimit(.minutes(1))) func typingAfterTheCaretMovedLandsWhereItIs() async throws {
        let shown = try await Screen.run(text: "") { screen in
            let first = try await screen.start()
            screen.keys("Alpha\nBe")
            first.selectedRange = NSRange(location: 2, length: 0)
            screen.keys("X")
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["AlXphaBe", ""], "\(shown)")
    }

    /// Backspace at the block's start does what it does anywhere: a
    /// checklist item turns into a paragraph.
    @Test(.timeLimit(.minutes(1))) func backspaceAtTheStartActsAsUsual() async throws {
        let blocks = try await Screen.run("checkListItem", text: "milk") { screen in
            _ = try await screen.start(caret: 0)
            screen.keys("\n")
            screen.backspace()
            try await screen.finish(blocks: 2)
            return screen.editor.all
        }
        #expect(blocks.map(\.kind) == ["paragraph", "checkListItem"])
        #expect(blocks.map { BlockText.shown($0.inline) } == ["milk", ""])
    }

    // MARK: Links and attachments in held keys (REVIEW-4707 M2)

    /// A `[[link]]` typed among the held keys reaches the new block as
    /// text it can link, never as the old block's bare chip placeholder.
    @Test(.timeLimit(.minutes(1))) func aLinkTypedAfterReturnReachesTheNewBlockAsText() async throws {
        let shown = try await Screen.run(text: "Alpha") { screen in
            _ = try await screen.start()
            screen.keys("\n[[Foo]]")
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["Alpha", "[[Foo]]"], "\(shown)")
    }

    /// An attachment among the held keys cannot be typed again: the keys
    /// stay in the old block with it.
    @Test(.timeLimit(.minutes(1))) func heldKeysWithAnAttachmentStayInTheirBlock() async throws {
        let shown = try await Screen.run(text: "Alpha") { screen in
            _ = try await screen.start()
            screen.keys("\nA\(BlockText.placeholder)B")
            try await screen.finish(blocks: 2)
            return screen.editor.shown
        }
        #expect(shown == ["AlphaA\(BlockText.placeholder)B", ""], "\(shown)")
    }

    // MARK: The new block never takes the caret (REVIEW-4707 M3)

    /// The core refuses the new block: the keys stay where they were typed,
    /// and the editor shows the failure.
    @Test(.timeLimit(.minutes(1))) func aRefusedBlockLeavesTheKeysInTheOldOne() async throws {
        let (shown, failed) = try await Screen.run(text: "") { screen in
            screen.editor.inserts.withLock { $0 = .refuse }
            _ = try await screen.start()
            screen.keys("Alpha\nBeta")
            var failed = false
            for _ in 0 ..< 80 where !failed {
                if case .failed = screen.model.status { failed = true } else { try await Task.sleep(for: .milliseconds(25)) }
            }
            try await screen.finish(blocks: 1)
            return (screen.editor.shown, failed)
        }
        #expect(shown == ["AlphaBeta"], "\(shown)")
        #expect(failed, "the refused block shows as a failed save")
    }

    /// A tap in another block before the new one is drawn: the keys stay
    /// in the old block.
    @Test(.timeLimit(.minutes(1))) func aTapElsewhereDuringTheHoldKeepsTheKeys() async throws {
        let shown = try await Screen.run(text: "", below: ["other"]) { screen in
            screen.editor.inserts.withLock { $0 = .wait }
            _ = try await screen.start()
            screen.keys("Alpha\nBeta")
            let other = try #require(screen.textViews().last)
            #expect(other.becomeFirstResponder())
            screen.editor.inserts.withLock { $0 = .land }
            try await screen.finish(blocks: 3)
            return screen.editor.shown
        }
        #expect(shown == ["AlphaBeta", "", "other"], "\(shown)")
    }

    /// Leaving the app before the new block is drawn commits the keys to
    /// the old block, so a kill from the app switcher keeps them, and the
    /// new block takes none of them once it is drawn.
    @Test(.timeLimit(.minutes(1))) func leavingTheAppDuringTheHoldCommitsTheKeys() async throws {
        let shown = try await Screen.run(text: "") { screen in
            screen.editor.inserts.withLock { $0 = .wait }
            _ = try await screen.start()
            screen.keys("Alpha\nBeta")
            NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
            screen.editor.inserts.withLock { $0 = .land }
            // No resign here: what lands is what leaving the app committed.
            for _ in 0 ..< 80 where screen.editor.all.count < 2 { try await Task.sleep(for: .milliseconds(25)) }
            try await Task.sleep(for: .milliseconds(200))
            screen.model.session.enqueue {}
            await screen.model.session.tail?.value
            return screen.editor.shown
        }
        #expect(shown == ["AlphaBeta", ""], "\(shown)")
    }

    /// #4722: keys typed into the block a Return made, once it holds the
    /// caret, are committed as the app leaves, so a kill keeps them.
    @Test(.timeLimit(.minutes(1))) func leavingTheAppAfterTypingInTheNewBlockCommitsIt() async throws {
        let shown = try await Screen.run(text: "") { screen in
            let first = try await screen.start()
            screen.keys("Alpha\n")
            for _ in 0 ..< 80 where screen.focused == nil || screen.focused === first || screen.editor.all.count < 2 {
                try await Task.sleep(for: .milliseconds(25))
            }
            try await Task.sleep(for: .milliseconds(200))
            screen.keys("Beta")
            NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
            // No resign here: what lands is what leaving the app committed.
            screen.model.session.enqueue {}
            await screen.model.session.tail?.value
            return screen.editor.shown
        }
        #expect(shown == ["Alpha", "Beta"], "\(shown)")
    }
}
