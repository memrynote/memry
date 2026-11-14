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
    /// Asks for an address, then links `textView`'s selection as it stood
    /// when the prompt opened. Add and Cancel give the block its caret and
    /// selection back.
    static func present(session: EditorSession, textView: UITextView) {
        guard var presenter = textView.window?.rootViewController else {
            Log.interface.error("link prompt: the block is not on screen")
            return
        }
        while let next = presenter.presentedViewController { presenter = next }
        let selection = textView.selectedRange
        let alert = UIAlertController(title: "Link", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "https://"
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak textView] _ in
            guard let textView else { return }
            finish(nil, selection: selection, textView: textView, session: session)
        })
        alert.addAction(UIAlertAction(title: "Add", style: .default) { [weak alert, weak textView] _ in
            guard let textView else { return }
            finish(alert?.textFields?.first?.text, selection: selection, textView: textView, session: session)
        })
        alert.preferredAction = alert.actions.last
        presenter.present(alert, animated: true)
    }

    /// Puts the caret back over `selection`, then links it to `address`
    /// when there is one.
    static func finish(_ address: String?, selection: NSRange, textView: UITextView, session: EditorSession) {
        textView.becomeFirstResponder()
        textView.selectedRange = selection
        let trimmed = address?.trimmingCharacters(in: .whitespaces) ?? ""
        if !trimmed.isEmpty { session.toggleMark("link", value: trimmed) }
    }
}
