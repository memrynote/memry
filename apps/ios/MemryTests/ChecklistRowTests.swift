//
//  ChecklistRowTests.swift
//  An editable checklist row as the page draws it: a ticked item's text is
//  struck through, as desktop draws it, and an empty item's caret sits
//  beside its box, where a typed item's text does.
//

import Foundation
import MemryCore
import Synchronization
import SwiftUI
import Testing
import UIKit

@testable import Memry

/// One checklist item held in memory, taking the editor's prop writes.
private final class ItemEditor: BlockEditing, @unchecked Sendable {
    let item: Mutex<Block>

    init(_ item: Block) { self.item = Mutex(item) }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        if case let .setProp(_, name, value) = edit {
            item.withLock { item in
                item.props = item.props.filter { $0.name != name } + [BlockProp(name: name, value: value)]
            }
        }
        return true
    }

    var current: Block { item.withLock { $0 } }
}

@MainActor
@Observable
private final class Page {
    var item: Block
    var generation = 0
    init(_ item: Block) { self.item = item }
}

private struct Row: View {
    let page: Page
    let model: NoteEditorViewModel
    let editor: ItemEditor

    var body: some View {
        let bridge = NoteEditingBridge(model: model, drawnGeneration: { page.generation }) {
            page.generation = model.session.landedWrites
            page.item = editor.current
        }
        VStack {
            NoteBlockView(block: page.item, editing: bridge)
            Spacer()
        }
    }
}

extension KeyWindowSuites {
    @MainActor
    @Suite("Checklist rows")
    struct ChecklistRowTests {
        private static func item(_ text: String) -> Block {
            Block(
                id: "c1", kind: "checkListItem", depth: 0, props: [BlockProp(name: "checked", value: "false")],
                inline: text.isEmpty ? [] : [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
            )
        }

        private static func textView(in view: UIView) -> BlockTextView? {
            view as? BlockTextView ?? view.subviews.lazy.compactMap(textView).first
        }

        /// Draws `item` in a window and hands its text view to `body`.
        private func drawn(
            _ item: Block, _ body: (BlockTextView, NoteEditorViewModel) async throws -> Void
        ) async throws {
            let editor = ItemEditor(item)
            let model = NoteEditorViewModel(noteId: "n1", editor: editor)
            model.session.model = model
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
            window.rootViewController = UIHostingController(rootView: Row(page: Page(item), model: model, editor: editor))
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            // A loaded host draws the row later than a fixed wait allows (#5780).
            for _ in 0..<300 where Self.textView(in: window) == nil {
                try await Task.sleep(for: .milliseconds(20))
            }
            window.layoutIfNeeded()
            try await body(try #require(Self.textView(in: window)), model)
        }

        private static func struck(_ view: BlockTextView) -> Bool {
            let storage = view.textStorage
            guard storage.length > 0 else { return false }
            var whole = NSRange()
            let style = storage.attribute(
                .strikethroughStyle, at: 0, longestEffectiveRange: &whole, in: NSRange(location: 0, length: storage.length)
            )
            return (style as? Int) == NSUnderlineStyle.single.rawValue && whole.length == storage.length
        }

        @Test(.timeLimit(.minutes(1))) func ticking_an_item_strikes_its_text_and_unticking_clears_it() async throws {
            try await drawn(Self.item("Buy milk")) { view, model in
                #expect(!Self.struck(view))

                await model.setProp("c1", "checked", "true")
                await model.session.didChange()
                try await Task.sleep(for: .milliseconds(200))
                #expect(Self.struck(view))
                // Typed on a ticked line stays struck, as desktop's line does.
                #expect((view.typingAttributes[.strikethroughStyle] as? Int) == NSUnderlineStyle.single.rawValue)

                await model.setProp("c1", "checked", "false")
                await model.session.didChange()
                try await Task.sleep(for: .milliseconds(200))
                #expect(!Self.struck(view))
            }
        }

        /// UIKit puts an empty text view's first baseline at its top, so the row
        /// aligned the box's baseline with it and drew the caret a line below.
        @Test(.timeLimit(.minutes(1))) func an_empty_items_text_sits_where_a_typed_items_does() async throws {
            var tops: [CGFloat] = []
            for text in ["", "Buy milk"] {
                try await drawn(Self.item(text)) { view, _ in
                    tops.append(view.convert(CGPoint.zero, to: nil).y)
                }
            }
            #expect(abs(tops[0] - tops[1]) < 1, "empty at \(tops[0]), typed at \(tops[1])")
        }
    }
}
