import MemryCore
import SwiftUI

// TP052. Desktop's `delete-project-dialog.tsx`: the task count, then the
// choice. A project with tasks offers "Move tasks to Inbox" (the phone's
// addition, §6 TP021) beside desktop's "delete them"; an empty one only
// confirms. The Inbox never reaches this dialog (the core refuses it too).

private typealias Copy = TasksCopy.Projects

private struct ProjectDeleteDialog: ViewModifier {
    @Binding var project: ProjectItem?
    let store: TasksStore
    let onDeleted: () -> Void

    /// Counted from the tasks the store already holds, not fetched: a count
    /// that arrived after the dialog opened showed a project with tasks as
    /// empty, and its one button would have deleted every task in it.
    private var taskCount: Int {
        guard let id = project?.id else { return 0 }
        return store.items.values.filter { $0.projectId == id }.count
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                Copy.deleteProjectTitle(project?.name ?? ""),
                isPresented: isPresented,
                titleVisibility: .visible,
                presenting: project
            ) { project in
                if taskCount > 0 {
                    Button(Copy.moveTasksToInbox) { delete(project, moveTasks: true) }
                        .accessibilityIdentifier("tasks.projectDelete.moveToInbox")
                    Button(Copy.deleteAllTasks, role: .destructive) { delete(project, moveTasks: false) }
                        .accessibilityIdentifier("tasks.projectDelete.deleteTasks")
                } else {
                    Button(Copy.deleteProject, role: .destructive) { delete(project, moveTasks: false) }
                        .accessibilityIdentifier("tasks.projectDelete.confirm")
                }
                Button(Copy.cancel, role: .cancel) {}
            } message: { _ in
                Text(message)
            }
    }

    private var message: String {
        guard taskCount > 0 else { return "\(Copy.projectHasNoTasks) \(Copy.cannotBeUndone)" }
        return "\(Copy.projectHasTasks(taskCount)) \(Copy.whatToDoWithTasks) \(Copy.cannotBeUndone)"
    }

    private var isPresented: Binding<Bool> {
        Binding(get: { project != nil }, set: { if !$0 { project = nil } })
    }

    private func delete(_ target: ProjectItem, moveTasks: Bool) {
        project = nil
        Task {
            if await store.deleteProject(target.id, moveTasksToInbox: moveTasks) { onDeleted() }
        }
    }
}

extension View {
    /// Asks how to delete `project` while it is non-`nil`.
    func projectDeleteDialog(
        _ project: Binding<ProjectItem?>,
        store: TasksStore,
        onDeleted: @escaping () -> Void = {}
    ) -> some View {
        modifier(ProjectDeleteDialog(project: project, store: store, onDeleted: onDeleted))
    }
}
