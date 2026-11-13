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
        #expect(editor.all == [.setText(blockId: "c1", text: "Buy milk")])
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

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            model.session.reload = { done.resume() }
            model.session.returnPressed(field)
        }

        let edits = editor.all
        guard case let .insertBlock(kind, _, _, newId)? = edits.dropFirst().first else {
            Issue.record("no block was inserted: \(edits)")
            return
        }
        #expect(kind == "checkListItem")
        #expect(edits.last == .setProp(blockId: newId, name: "plain", value: "true"))
    }
}
