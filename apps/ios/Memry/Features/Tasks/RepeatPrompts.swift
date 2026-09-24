import MemryCore
import SwiftUI

// TP045. The two questions a repeating task asks, hosted once at the Tasks
// root and answered from `store.prompt`:
//
// - **Stop Repeating** (`stop-repeating-dialog.tsx`): keep this task as a
//   one-time task, or delete this and all future occurrences.
// - **Edit Repeating** (`edit-repeating-task-dialog.tsx`): apply the pending
//   edit to only this occurrence, or to this and all future ones.
//
// The task and the pending edit travel as the dialog's presented value, so
// closing the dialog (which clears the prompt) never loses what a button
// is about to write.

struct RepeatPromptsHost: ViewModifier {
    let store: TasksStore

    /// The Edit Repeating question's subject.
    struct EditTarget {
        let task: TaskItem
        let edit: RepeatingEdit
    }

    private var stopTarget: TaskItem? {
        guard case let .stopRepeating(id) = store.prompt else { return nil }
        return store.items[id]
    }

    private var editTarget: EditTarget? {
        guard case let .editRepeating(id) = store.prompt,
              let task = store.items[id],
              let edit = store.pendingRepeatingEdit(taskId: id)
        else { return nil }
        return EditTarget(task: task, edit: edit)
    }

    private func shown(_ isShown: Bool) -> Binding<Bool> {
        Binding(
            get: { isShown },
            set: { if !$0 { store.dismissRepeatingPrompt() } }
        )
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                TasksCopy.stopRepeatingTitle,
                isPresented: shown(stopTarget != nil),
                titleVisibility: .visible,
                presenting: stopTarget
            ) { task in
                Button(TasksCopy.stopRepeatingKeep) {
                    Task { await store.stopRepeating(taskId: task.id, deleteSeries: false) }
                }
                .accessibilityIdentifier("tasks.repeat.stop.keep")
                Button(TasksCopy.stopRepeatingDelete, role: .destructive) {
                    Task { await store.stopRepeating(taskId: task.id, deleteSeries: true) }
                }
                .accessibilityIdentifier("tasks.repeat.stop.delete")
                Button(TasksCopy.repeatingDialogCancel, role: .cancel) {}
            } message: { task in
                Text(TasksCopy.stopRepeatingMessage(title: task.title, rule: task.repeat))
            }
            .confirmationDialog(
                TasksCopy.editRepeatingTitle,
                isPresented: shown(editTarget != nil),
                titleVisibility: .visible,
                presenting: editTarget
            ) { target in
                Button(TasksCopy.editRepeatingOnlyThis) {
                    Task { await store.applyRepeatingEdit(taskId: target.task.id, target.edit, onlyThis: true) }
                }
                .accessibilityIdentifier("tasks.repeat.edit.onlyThis")
                Button(TasksCopy.editRepeatingThisAndFuture) {
                    Task { await store.applyRepeatingEdit(taskId: target.task.id, target.edit, onlyThis: false) }
                }
                .accessibilityIdentifier("tasks.repeat.edit.thisAndFuture")
                Button(TasksCopy.repeatingDialogCancel, role: .cancel) {}
            } message: { _ in
                Text(TasksCopy.editRepeatingMessage)
            }
    }
}
