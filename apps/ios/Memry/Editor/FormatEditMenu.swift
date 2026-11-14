//
//  FormatEditMenu.swift
//  The Format submenu in the system edit menu over a selection.
//
//  The same marks, colours and link the keyboard toolbar writes, through the
//  same `EditorSession.toggleMark`, so a long-press on selected text formats
//  it without opening the `Aa` panel.
//

import SwiftUI
import UIKit

@MainActor
enum FormatEditMenu {
    /// The boolean marks, in desktop's formatting toolbar order.
    static let marks: [(id: String, name: String, symbol: String)] = [
        ("bold", "Bold", "bold"),
        ("italic", "Italic", "italic"),
        ("underline", "Underline", "underline"),
        ("strike", "Strikethrough", "strikethrough"),
        ("code", "Code", "chevron.left.forwardslash.chevron.right"),
    ]

    static func menu(session: EditorSession, textView: UITextView) -> UIMenu {
        let active = session.selectionMarks
        var children: [UIMenuElement] = marks.map { mark in
            let action = UIAction(
                title: mark.name, image: UIImage(systemName: mark.symbol)
            ) { _ in session.toggleMark(mark.id) }
            action.state = active.contains(mark.id) ? .on : .off
            return action
        }
        let linked = active.contains("link")
        children.append(UIAction(
            title: linked ? "Remove Link" : "Link\u{2026}", image: UIImage(systemName: "link")
        ) { [weak textView] _ in
            if linked {
                session.toggleMark("link")
            } else if let textView {
                LinkPrompt.present(session: session, textView: textView)
            }
        })
        children.append(colours(title: "Text Colour", symbol: "paintpalette", mark: "textColor", session: session) {
            Tokens.Content.ink(named: $0)?.color
        })
        children.append(colours(title: "Highlight", symbol: "highlighter", mark: "backgroundColor", session: session) {
            Tokens.Content.fill(named: $0)?.color
        })
        return UIMenu(title: "Format", image: UIImage(systemName: "textformat"), children: children)
    }

    private static func colours(
        title: String, symbol: String, mark: String, session: EditorSession, swatch: (String) -> Color?
    ) -> UIMenu {
        var children: [UIMenuElement] = [UIAction(title: "Default") { _ in session.toggleMark(mark, value: "default") }]
        for name in Tokens.Content.names {
            let image = swatch(name).map {
                UIImage(systemName: "circle.fill")?.withTintColor(UIColor($0), renderingMode: .alwaysOriginal)
            } ?? nil
            children.append(UIAction(title: name.capitalized, image: image) { _ in
                session.toggleMark(mark, value: name)
            })
        }
        return UIMenu(title: title, image: UIImage(systemName: symbol), children: children)
    }
}
