import SwiftUI
import UIKit

// #4355. ↑ ↓ and Return over a list that sits beside a detail column at
// regular width (Notes, Inbox, Tasks): ↑ ↓ move the list's selection, Return
// opens the selected row. Desktop's lists do the same (`use-inbox-keyboard.ts`).
//
// Bare keys belong to the caret while a text view or field is being edited,
// so they are registered only while none is, as the journal day's ← → are.
// They never fire under a sheet or the search palette (`MemryCommands`).

struct ListKeys: View {
    /// The rows' ids, in the order the list draws them.
    let ids: [String]
    /// The selected row, if any.
    let current: String?
    /// ↑ ↓: select `id`.
    let move: (String) -> Void
    /// Return: open `id`.
    let open: (String) -> Void

    @State private var editingText = false

    /// The row ↑ (`-1`) or ↓ (`1`) lands on. With nothing selected, ↓ takes
    /// the first row and ↑ the last; the ends do not wrap.
    static func step(_ ids: [String], from current: String?, by delta: Int) -> String? {
        guard let index = current.flatMap(ids.firstIndex(of:)) else {
            return delta > 0 ? ids.first : ids.last
        }
        let next = index + delta
        return ids.indices.contains(next) ? ids[next] : nil
    }

    var body: some View {
        ZStack {
            if !editingText {
                Button("Previous") { step(-1) }
                    .keyboardShortcut(.upArrow, modifiers: [])
                Button("Next") { step(1) }
                    .keyboardShortcut(.downArrow, modifiers: [])
                Button("Open") {
                    guard !MemryCommands.isPresenting, let current, ids.contains(current) else { return }
                    open(current)
                }
                .keyboardShortcut(.return, modifiers: [])
            }
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onTextEditing { editingText = $0 }
    }

    private func step(_ delta: Int) {
        guard !MemryCommands.isPresenting, let id = Self.step(ids, from: current, by: delta) else { return }
        move(id)
    }
}

extension View {
    /// Calls `change` with whether a text view or field holds the keyboard.
    /// UIKit ends one editor before the next begins, so the last of these
    /// notifications says which.
    func onTextEditing(_ change: @escaping (Bool) -> Void) -> some View {
        let center = NotificationCenter.default
        return onReceive(center.publisher(for: UITextView.textDidBeginEditingNotification)) { _ in change(true) }
            .onReceive(center.publisher(for: UITextView.textDidEndEditingNotification)) { _ in change(false) }
            .onReceive(center.publisher(for: UITextField.textDidBeginEditingNotification)) { _ in change(true) }
            .onReceive(center.publisher(for: UITextField.textDidEndEditingNotification)) { _ in change(false) }
    }
}
