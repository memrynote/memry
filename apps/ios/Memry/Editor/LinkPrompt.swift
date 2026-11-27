//
//  LinkPrompt.swift
//  The Link prompt: the toolbar's link button, ⇧⌘K and the edit menu's
//  Link… all ask here.
//
//  A UIKit alert presented over the page, never a SwiftUI `.alert` on the
//  keyboard toolbar: that one lives in the block's input accessory, so the
//  block kept the keys and typing the address replaced the selected text, and
//  on iPhone the accessory's redraw closed it (#4667).
//

import UIKit

@MainActor
enum LinkPrompt {
    /// What the prompt opened over. The block can change while it is open
    /// (a peer's edit drawn in, its row reused for another block), and then
    /// the saved range no longer names the text the user selected.
    struct Target {
        let blockId: String
        let text: String
        let selection: NSRange
    }

    static let textChanged = UserFacingError(
        code: "editor.linkTextChanged",
        title: "The text changed, so the link wasn't added.",
        guidance: "Select it again.",
        recourse: .retry,
        isUserVisible: true
    )

    /// Asks for an address, then links `field`'s selection as it stood when
    /// the prompt opened. Add and Cancel give the block its caret and
    /// selection back.
    static func present(session: EditorSession, field: BlockField) {
        guard var presenter = field.textView.window?.rootViewController else {
            Log.interface.error("link prompt: the block is not on screen")
            return
        }
        while let next = presenter.presentedViewController { presenter = next }
        let target = Target(blockId: field.blockId, text: field.textView.text, selection: field.textView.selectedRange)
        let alert = UIAlertController(title: "Link", message: nil, preferredStyle: .alert)
        alert.addTextField { text in
            text.placeholder = "https://"
            text.keyboardType = .URL
            text.autocapitalizationType = .none
            text.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak field] _ in
            guard let field else { return }
            finish(nil, target: target, field: field, session: session)
        })
        alert.addAction(UIAlertAction(title: "Add", style: .default) { [weak alert, weak field] _ in
            guard let field else {
                Log.interface.error("link prompt: the block left the page, link not added")
                return
            }
            finish(alert?.textFields?.first?.text, target: target, field: field, session: session)
        })
        alert.preferredAction = alert.actions.last
        presenter.present(alert, animated: true)
    }

    /// Puts the caret back over the target's selection, clamped to the text
    /// as it is now, then links it to `address` when there is one. A block
    /// that is no longer the target's block and text is left unlinked, and
    /// the user is told.
    static func finish(_ address: String?, target: Target, field: BlockField, session: EditorSession) {
        let textView = field.textView
        textView.becomeFirstResponder()
        let length = textView.textStorage.length
        let location = min(target.selection.location, length)
        textView.selectedRange = NSRange(location: location, length: min(target.selection.length, length - location))
        let trimmed = address?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !trimmed.isEmpty else { return }
        guard field.blockId == target.blockId, textView.text == target.text else {
            Log.interface.error("link prompt: the block changed while the prompt was open, link not added", .code(textChanged.code))
            session.failure = textChanged
            return
        }
        session.toggleMark("link", value: trimmed)
    }
}
