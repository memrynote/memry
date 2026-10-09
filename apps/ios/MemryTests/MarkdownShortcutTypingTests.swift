//
//  MarkdownShortcutTypingTests.swift
//  #2946: a block shortcut keeps the keystrokes typed after it.
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
                update(&blocks, blockId) { $0.inline = [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)] }
            case let .turnInto(blockId, kind):
                update(&blocks, blockId) { $0.kind = kind }
            default:
                break
            }
        }
        return true
    }

    private func update(_ blocks: inout [Block], _ id: String, _ change: (inout Block) -> Void) {
        guard let index = blocks.firstIndex(where: { $0.id == id }) else { return }
        change(&blocks[index])
    }

    var all: [Block] { blocks.withLock { $0 } }
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

@MainActor
@Suite("Markdown shortcut typing")
struct MarkdownShortcutTypingTests {
    private static func textViews(in view: UIView) -> [BlockTextView] {
        (view as? BlockTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }

    /// The Meeting Notes template seeds a `-` paragraph. Typing " persisted"
    /// after it makes a bullet holding "persisted", as desktop's input rule
    /// does. Before the fix the caret never reached the redrawn bullet row,
    /// and the letters typed into the paragraph row it replaced were lost.
    @Test(.timeLimit(.minutes(1))) func typing_after_a_dash_keeps_the_text_in_the_new_bullet() async throws {
        let dash = Block(
            id: "a", kind: "paragraph", depth: 0, props: [],
            inline: [InlineRun(text: "-", marks: [], markAttrs: [:], target: nil)]
        )
        let editor = BodyEditor([dash])
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let page = Page([dash])
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        window.rootViewController = UIHostingController(rootView: Body(page: page, model: model, editor: editor))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))

        let first = try #require(Self.textViews(in: window).first)
        first.becomeFirstResponder()
        first.selectedRange = NSRange(location: 1, length: 0)
        // Every text view the page has drawn, so a keystroke reaches the one
        // holding the caret even after its row left the window.
        var drawn = [first]
        // Keystrokes as the keyboard sends them: to the first responder,
        // through the delegate, the page redrawing between.
        for character in " persisted" {
            var target: BlockTextView?
            for _ in 0 ..< 40 {
                drawn += Self.textViews(in: window).filter { view in !drawn.contains { $0 === view } }
                target = drawn.first { $0.isFirstResponder }
                if target != nil { break }
                try await Task.sleep(for: .milliseconds(25))
            }
            let field = try #require(target, "no text view holds the caret")
            let key = String(character)
            if field.delegate?.textView?(field, shouldChangeTextIn: field.selectedRange, replacementText: key) != false {
                field.insertText(key)
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        try await Task.sleep(for: .milliseconds(300))
        // Typing ends; whatever text view holds the caret commits.
        drawn.first { $0.isFirstResponder }?.resignFirstResponder()
        for _ in 0 ..< 40 where editor.all.first.map({ BlockText.shown($0.inline) }) != "persisted" {
            try await Task.sleep(for: .milliseconds(50))
        }

        let block = try #require(editor.all.first)
        #expect(block.kind == "bulletListItem")
        #expect(BlockText.shown(block.inline) == "persisted")
    }
}
