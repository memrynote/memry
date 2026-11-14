import SwiftUI
import UIKit

// #4351, epic #4334 keyboard decisions. The day page's own hardware keys,
// carried by hidden buttons: Esc drills up, and plain ← / → (desktop
// `pages/journal.tsx` keydown) change the day only while no text view or
// field is being edited: they are never registered then, so the caret keeps
// its arrow keys. ⌥⌘← / ⌥⌘→ and ⌘T are app commands (`MemryCommands`),
// which reach this page through `JournalDayCommands`.

struct JournalDayShortcuts: View {
    let step: (Int) -> Void
    let drillUp: () -> Void

    @State private var editingText = false

    var body: some View {
        ZStack {
            if !editingText {
                Button(JournalCopy.previousDay) { step(-1) }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                Button(JournalCopy.nextDay) { step(1) }
                    .keyboardShortcut(.rightArrow, modifiers: [])
            }
            Button(JournalCopy.backToMonth, action: drillUp)
                .keyboardShortcut(.cancelAction)
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        // UIKit ends one editor before the next begins, so the last of
        // these says whether a text input holds the keyboard.
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { _ in
            editingText = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { _ in
            editingText = false
        }
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { _ in
            editingText = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidEndEditingNotification)) { _ in
            editingText = false
        }
    }
}
