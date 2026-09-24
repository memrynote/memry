import SwiftUI

// TP047. The hardware keyboard over the task list, after desktop's
// `pages/tasks.tsx` keydown handler: Cmd+A selects every visible task; with a
// selection, Cmd+Return completes it, Cmd+Delete asks to delete it, and Esc
// clears it. Each is a hidden button carrying a `keyboardShortcut`, titled so
// the iPad shortcut overlay lists it (common `shortcuts.tasks.*`).

struct TaskSelectionKeyboard: ViewModifier {
    let store: TasksStore
    @Binding var selection: Set<String>
    let visibleIds: [String]

    @State private var isConfirmingDelete = false

    func body(content: Content) -> some View {
        content
            .background { shortcuts }
            .taskSelectionDeleteDialog(store: store, selection: $selection, isPresented: $isConfirmingDelete)
    }

    @ViewBuilder private var shortcuts: some View {
        ZStack {
            Button(TasksCopy.shortcutSelectAll) {
                selection.selectAll(in: visibleIds)
            }
            .keyboardShortcut("a", modifiers: .command)

            if !selection.isEmpty {
                Button(TasksCopy.shortcutComplete) {
                    TaskSelectionWrite(store: store, selection: $selection).callAsFunction {
                        await store.completeSelection($0)
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)

                Button(TasksCopy.shortcutDelete) {
                    isConfirmingDelete = true
                }
                .keyboardShortcut(.delete, modifiers: .command)

                Button(TasksCopy.shortcutClearSelection) {
                    selection.removeAll()
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
