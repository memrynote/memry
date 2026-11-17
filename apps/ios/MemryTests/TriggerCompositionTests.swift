//
//  TriggerCompositionTests.swift
//  #4808: the toolbar `@` tapped while an IME composition is open keeps the
//  composed text, and the pick it opens keeps the text after the caret.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

@Suite("A toolbar trigger during a composition", .serialized)
@MainActor
struct TriggerCompositionTests {
    @Test(.timeLimit(.minutes(1)))
    func a_mention_started_mid_composition_keeps_the_composed_text_and_the_text_after() async throws {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Undo", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId, edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: "A z", newBlockId: blockId)
        )
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        model.session.model = model
        let block = try #require(try await reader.blocks(id: noteId)?.first { $0.id == blockId })
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
        field.render()
        model.session.focusChanged(to: field)
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 200)
        window.rootViewController = UIViewController()
        field.textView.delegate = field
        field.textView.frame = CGRect(x: 0, y: 40, width: 400, height: 60)
        window.rootViewController?.view.addSubview(field.textView)
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        #expect(field.textView.becomeFirstResponder())
        field.textView.selectedRange = NSRange(location: 2, length: 0)
        field.textView.setMarkedText("にほn", selectedRange: NSRange(location: 3, length: 0))
        let keyboard = KeyboardSpy(forwardingTo: field.textView.inputDelegate)
        field.textView.inputDelegate = keyboard

        model.session.startTrigger("@")
        field.textView.inputDelegate = keyboard.keyboard
        // Without a selection change the Japanese keyboard keeps `にほn` and
        // composes it again into the next keys.
        #expect(keyboard.selectionChanges > 0)
        #expect(field.textView.text == "A にほn @z")
        #expect(field.textView.markedTextRange == nil)

        let range = try #require(model.session.trigger?.range)
        let today = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
        model.session.insertInline(.date(today), replacing: range)
        await model.session.tail?.value
        let runs = try #require(try await reader.blocks(id: noteId)?.first { $0.id == blockId }).inline
        #expect(BlockText.shown(runs) == "A にほn \u{FFFC} z")
    }
}

/// Counts the selection changes the keyboard hears and passes every call on.
@MainActor
private final class KeyboardSpy: NSObject, UITextInputDelegate {
    weak var keyboard: UITextInputDelegate?
    var selectionChanges = 0

    init(forwardingTo keyboard: UITextInputDelegate?) {
        self.keyboard = keyboard
    }

    func selectionWillChange(_ textInput: UITextInput?) { keyboard?.selectionWillChange(textInput) }
    func selectionDidChange(_ textInput: UITextInput?) {
        selectionChanges += 1
        keyboard?.selectionDidChange(textInput)
    }
    func textWillChange(_ textInput: UITextInput?) { keyboard?.textWillChange(textInput) }
    func textDidChange(_ textInput: UITextInput?) { keyboard?.textDidChange(textInput) }
    func conversationContext(_ context: UIConversationContext?, didChange textInput: UITextInput?) {
        keyboard?.conversationContext(context, didChange: textInput)
    }
}
