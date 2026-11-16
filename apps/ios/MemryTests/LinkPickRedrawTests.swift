//
//  LinkPickRedrawTests.swift
//  #4780: a note picked from the `[[` menu is drawn as its chip in the row
//  being typed in at once, on the real note page over the real core, also
//  when keys follow the pick before its write lands. A `@` date pick too.
//

import Foundation
import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

@Suite("A picked link is drawn in its row", .serialized)
@MainActor
struct LinkPickRedrawTests {
    enum Pick { case returnKey, tap }
    enum Menu: String { case link = "[[pan", date = "@tomorrow" }

    @Test(.timeLimit(.minutes(1)), arguments: [Pick.returnKey, .tap], [false, true])
    func thePickedLinkIsDrawnAtOnce(pick: Pick, typesOn: Bool) async throws {
        try await pickIsDrawnAtOnce(.link, pick: pick, typesOn: typesOn)
    }

    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func aDatePickedWithReturnIsDrawnAtOnce(typesOn: Bool) async throws {
        try await pickIsDrawnAtOnce(.date, pick: .returnKey, typesOn: typesOn)
    }

    private func pickIsDrawnAtOnce(_ menu: Menu, pick: Pick, typesOn: Bool) async throws {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        _ = try writer.create(title: "Pane", folderPath: nil)
        let noteId = try writer.create(title: "Agent Link Pick", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId, edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: "", newBlockId: blockId)
        )
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteReadViewModel(route: NoteRoute(id: noteId), reader: reader)
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        window.rootViewController = UIHostingController(rootView: NoteReadView(model: model, editor: editor))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        func row() -> BlockTextView? {
            func all(_ view: UIView) -> [BlockTextView] { ((view as? BlockTextView).map { [$0] } ?? []) + view.subviews.flatMap(all) }
            return all(window).first { $0.accessibilityIdentifier == "note.block.\(blockId)" }
        }
        func until(_ condition: () -> Bool) async {
            for _ in 0 ..< 300 where !condition() {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        await until { row() != nil && !model.vaultNotes.isEmpty }
        let view = try #require(row(), "the body has no row")
        let field = try #require(view.delegate as? BlockField)
        let session = try #require(field.session)
        session.hardwareKeyboard = HardwareKeyboard(attached: true)
        view.becomeFirstResponder()
        func key(_ text: String) {
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: text) != false {
                view.insertText(text)
            }
        }
        for character in "see " + menu.rawValue { key(String(character)) }
        let row = try #require(session.suggestions.first)
        switch (menu, row.kind) {
        case (.link, .note(title: "Pane", alias: "")), (.date, .date): break
        default: Issue.record("the menu leads with \(row.kind)")
        }

        switch pick {
        case .returnKey: key("\n")
        case .tap: session.choose(try #require(session.suggestions.first))
        }
        if typesOn {
            for character in " and more" { key(String(character)) }
        }
        let shown = typesOn ? "see \u{FFFC}  and more" : "see \u{FFFC} "
        await session.tail?.value
        await until { view.text == shown }

        // Drawn while the row still has the caret: nothing reloads it.
        #expect(view.isFirstResponder)
        #expect(view.text == shown, "row: \(view.text.debugDescription)")
        let chip = (view.text as NSString).range(of: "\u{FFFC}")
        #expect(chip.location == 4)
        guard chip.location != NSNotFound else { return }
        #expect(view.textStorage.attribute(.attachment, at: chip.location, effectiveRange: nil) != nil)
        let drawnTarget = view.textStorage.attribute(.memryWikiTarget, at: chip.location, effectiveRange: nil) as? String
        let drawnDate = view.textStorage.attribute(.memryDate, at: chip.location, effectiveRange: nil) as? DateMentionChip
        view.resignFirstResponder()
        await session.tail?.value
        let stored = try await reader.blocks(id: noteId)?.first { $0.id == blockId }
        #expect(stored.map { BlockText.shown($0.inline) } == shown, "stored: \(stored.map { BlockText.shown($0.inline) }.debugDescription)")
        switch menu {
        case .link: #expect(drawnTarget == "Pane")
        case .date:
            // A tap edits the chip drawn now by its anchor, which the core's node carries.
            let node = stored?.inline.first { $0.marks.contains("dateMention") }
            #expect(drawnDate != nil)
            #expect(drawnDate?.anchorId == node.flatMap(DateMentionChip.from)?.anchorId)
        }
    }
}
