//
//  ChecklistAutoTaskTests.swift
//  A checklist item typed and left turns into a task, as desktop's editor
//  turns one (`analyzeTaskIntents`), and Return in a plain checklist keeps the
//  next item plain (`plainByContext`). Whether a line converts is the core's
//  rule, pinned in Rust (`api_typed_checklist.rs`); this asserts the editor
//  asks at the right moment.
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

/// Begins `onShouldEnd` as UIKit asks `field`'s text view to end editing,
/// and hands every other delegate call to `field`.
private final class ResigningDelegate: NSObject, UITextViewDelegate {
    let field: BlockField
    let onShouldEnd: () -> Void
    init(_ field: BlockField, onShouldEnd: @escaping () -> Void) {
        self.field = field
        self.onShouldEnd = onShouldEnd
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || field.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? { field }

    func textViewShouldEndEditing(_ textView: UITextView) -> Bool {
        onShouldEnd()
        return true
    }
}

extension KeyWindowSuites {
    @MainActor
    @Suite("Checklist items typed into tasks")
    struct ChecklistAutoTaskTests {
        private let editor = RecordingEditor()
        private let model: NoteEditorViewModel

        init() {
            model = NoteEditorViewModel(noteId: "n1", editor: editor)
            model.session.model = model
        }

        private func field(kind: String, props: [String: String] = [:]) -> BlockField {
            let block = Block(
                id: "c1", kind: kind, depth: 0,
                props: props.map { BlockProp(name: $0.key, value: $0.value) }, inline: []
            )
            let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
            let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
            field.render()
            model.session.focusChanged(to: field)
            return field
        }

        private func type(_ text: String, in field: BlockField) {
            field.textView.text = text
            field.textViewDidChange(field.textView)
        }

        /// Ends editing in `field` and answers the block ids the session asked
        /// to convert, once its queued writes have run.
        private func leave(_ field: BlockField) async -> [String] {
            let asked = Mutex<[String]>([])
            model.session.convertTypedChecklist = { id in asked.withLock { $0.append(id) } }
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                model.session.reload = { done.resume() }
                field.textViewDidEndEditing(field.textView)
            }
            return asked.withLock { $0 }
        }

        @Test func aTypedChecklistItemIsConvertedAfterItsTextIsWritten() async {
            let field = field(kind: "checkListItem")
            type("Buy milk", in: field)

            let asked = await leave(field)

            #expect(asked == ["c1"])
            #expect(editor.all == [.replaceText(blockId: "c1", text: "Buy milk", base: "")])
        }

        /// `[] ` redraws the row as a checklist item with a new text view, and the
        /// old one resigns before the new one takes the caret: what was typed in
        /// the old one still counts.
        @Test func aLineTurnedIntoAChecklistItemByShortcutStillConverts() async {
            let paragraph = field(kind: "paragraph")
            type("Buy milk", in: paragraph)
            model.session.shortcutField = paragraph
            model.session.convertTypedChecklist = { _ in Issue.record("a paragraph is not converted") }
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                model.session.reload = { done.resume() }
                paragraph.textViewDidEndEditing(paragraph.textView)
            }

            let checklist = field(kind: "checkListItem")
            checklist.textViewDidBeginEditing(checklist.textView)
            let asked = await leave(checklist)

            #expect(asked == ["c1"])
            withExtendedLifetime(paragraph) {}
        }

        /// #5817: the redrawn row can take the caret while the old one resigns,
        /// as it moves into the window then: it begins editing before the old
        /// row ends, and never ends editing itself. The old row's typing is
        /// written all the same.
        @Test func typingTakenOverBeforeTheOldRowEndsEditingIsWritten() async {
            let paragraph = field(kind: "paragraph")
            type("milk", in: paragraph)
            model.session.shortcutField = paragraph

            let checklist = field(kind: "checkListItem")
            checklist.textViewDidBeginEditing(checklist.textView)
            paragraph.textViewDidEndEditing(paragraph.textView)
            await model.session.tail?.value

            #expect(editor.all == [.replaceText(blockId: "c1", text: "milk", base: "")])
            #expect(!checklist.dirty)
        }

        /// REVIEW-5829: in UIKit, a row that takes the caret while the old one
        /// resigns begins editing without holding the caret, so no key reaches
        /// it. Keys reach it once it takes the caret again, and it writes them
        /// when it lets go, with no page closing.
        @Test func keysTypedIntoTheRedrawnRowAreWrittenWhenItLetsGo() async throws {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
            window.rootViewController = UIViewController()
            window.isHidden = false
            defer { window.isHidden = true }
            let root = try #require(window.rootViewController?.view)
            let paragraph = field(kind: "paragraph")
            let checklist = field(kind: "checkListItem")
            for row in [paragraph, checklist] {
                row.textView.frame = CGRect(x: 0, y: 0, width: 300, height: 40)
                row.textView.delegate = row
            }
            root.addSubview(paragraph.textView)
            #expect(paragraph.textView.becomeFirstResponder())
            paragraph.textView.insertText("milk")
            model.session.shortcutField = paragraph
            // The redrawn row moves in, and takes the caret, as the old one resigns.
            let resigning = ResigningDelegate(paragraph) { root.addSubview(checklist.textView) }
            paragraph.textView.delegate = resigning
            paragraph.textView.removeFromSuperview()

            if !checklist.textView.isFirstResponder { #expect(checklist.textView.becomeFirstResponder()) }
            checklist.textView.insertText(" and eggs")
            checklist.textView.resignFirstResponder()
            await model.session.tail?.value

            #expect(editor.all == [
                .replaceText(blockId: "c1", text: "milk", base: ""),
                .replaceText(blockId: "c1", text: "milk and eggs", base: "milk")
            ])
            withExtendedLifetime(resigning) {}
        }

        @Test func aChecklistItemOnlyTappedThroughIsLeftAlone() async {
            let field = field(kind: "checkListItem")
            model.session.convertTypedChecklist = { _ in Issue.record("nothing was typed") }

            field.textViewDidEndEditing(field.textView)
            await Task.yield()

            #expect(editor.all.isEmpty)
        }

        @Test func aTypedParagraphIsNotAChecklistItem() async {
            let field = field(kind: "paragraph")
            type("Just prose", in: field)

            let asked = await leave(field)

            #expect(asked.isEmpty)
        }

        @Test func returnInAPlainChecklistMakesAnotherPlainCheckbox() async {
            let field = field(kind: "checkListItem", props: ["plain": "true"])
            type("Keep me", in: field)

            // The commit's write reloads first; the split's reload comes after.
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                let session = model.session
                session.reload = { [editor] in
                    guard editor.all.contains(where: { if case .splitBlock = $0 { true } else { false } }) else { return }
                    session.reload = {}
                    done.resume()
                }
                model.session.returnPressed(field)
            }

            let edits = editor.all
            guard case let .splitBlock(blockId, at, kind, newId)? = edits.dropFirst().first else {
                Issue.record("no block was split: \(edits)")
                return
            }
            #expect(blockId == "c1" && at == 7)
            #expect(kind == "checkListItem")
            #expect(edits.last == .setProp(blockId: newId, name: "plain", value: "true"))
        }
    }
}
