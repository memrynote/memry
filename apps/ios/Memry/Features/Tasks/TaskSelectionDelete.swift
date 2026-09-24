import MemryCore
import SwiftUI

// TP047. The bulk delete confirmation (`bulk-delete-dialog.tsx`): how many,
// the first five titles, "and N more", and that Undo can bring them back. The
// bar's Delete button and hardware Cmd+Delete both ask through it.

private struct TaskSelectionDeleteDialog: ViewModifier {
    let store: TasksStore
    @Binding var selection: Set<String>
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        let tasks = store.selectedTasks(selection)
        content.confirmationDialog(
            TasksCopy.deleteTitle(tasks.count),
            isPresented: $isPresented,
            titleVisibility: .visible
        ) {
            Button(TasksCopy.deleteConfirm(tasks.count), role: .destructive) {
                let chosen = selection
                Task {
                    if await store.deleteSelection(chosen) { selection.subtract(chosen) }
                }
            }
            .accessibilityIdentifier("tasks.bulk.delete.confirm")
            Button(TasksCopy.deleteCancel, role: .cancel) {}
        } message: {
            Text(TasksCopy.deleteMessage(titles: tasks.map(\.title), total: tasks.count))
        }
    }
}

extension View {
    /// Asks before deleting the selection; clears it once deleted.
    func taskSelectionDeleteDialog(
        store: TasksStore,
        selection: Binding<Set<String>>,
        isPresented: Binding<Bool>
    ) -> some View {
        modifier(TaskSelectionDeleteDialog(store: store, selection: selection, isPresented: isPresented))
    }
}
