import MemryCore
import SwiftUI

// TP041. The row's swipe actions and context menu.
//
// **The context menu is desktop's Move menu** (`drag-drop/move-menu.tsx`):
// Reschedule (Today, Tomorrow, Next week, Remove date), Move to project (live
// projects, the current one disabled), Change status (the project's statuses,
// the current one disabled), then duplicate, make subtask of..., archive and
// delete. Desktop's Reorder section is left to drag (TP050).
//
// **Swipes are the phone's shortcuts**: leading completes (or reopens),
// trailing deletes or opens the reschedule list. Delete is not confirmed here:
// it goes through `requestDelete`, which asks when a parent has subtasks, and
// the toast offers Undo, as desktop's delete does.
//
// **Duplicate asks only when there are subtasks to copy**
// (`duplicate-with-subtasks-dialog.tsx`); a task without subtasks is copied at
// once.

struct TaskRowActions: ViewModifier {
    let task: TaskItem
    let store: TasksStore
    let complete: () -> Void

    @State private var isPickingParent = false
    @State private var isConfirmingDuplicate = false

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(action: complete) {
                    Label(
                        task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete,
                        systemImage: task.isDone ? "arrow.uturn.backward.circle" : "checkmark.circle"
                    )
                }
                .tint(Tokens.Task.complete.color)
                .accessibilityIdentifier("tasks.row.swipe.complete")
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive, action: delete) {
                    Label(TasksCopy.rowDelete, systemImage: "trash")
                }
                .accessibilityIdentifier("tasks.row.swipe.delete")
                Menu {
                    TaskRescheduleButtons(task: task, store: store)
                } label: {
                    Label(TasksCopy.rowReschedule, systemImage: "calendar")
                }
                .tint(Tokens.Task.dueTomorrow.color)
                .accessibilityIdentifier("tasks.row.swipe.reschedule")
            }
            .contextMenu {
                TaskRowMenu(
                    task: task,
                    store: store,
                    duplicate: duplicate,
                    pickParent: { isPickingParent = true },
                    delete: delete
                )
            }
            .sheet(isPresented: $isPickingParent) {
                ParentPickerSheet(task: task, store: store)
            }
            .confirmationDialog(
                TasksCopy.rowDuplicateTitle,
                isPresented: $isConfirmingDuplicate,
                titleVisibility: .visible
            ) {
                let subtasks = store.subtasks(of: task.id).count
                Button(TasksCopy.rowDuplicateWithItems(subtasks + 1)) { runDuplicate(withSubtasks: true) }
                    .accessibilityIdentifier("tasks.row.duplicate.withSubtasks")
                Button(TasksCopy.rowDuplicateTaskOnly) { runDuplicate(withSubtasks: false) }
                    .accessibilityIdentifier("tasks.row.duplicate.taskOnly")
                Button(TasksCopy.rowCancel, role: .cancel) {}
            } message: {
                Text(TasksCopy.rowDuplicateMessage(task.title))
            }
    }

    private func delete() {
        let task = task
        Task { await store.requestDelete(task) }
    }

    private func duplicate() {
        if store.subtasks(of: task.id).isEmpty {
            runDuplicate(withSubtasks: false)
        } else {
            isConfirmingDuplicate = true
        }
    }

    private func runDuplicate(withSubtasks: Bool) {
        let task = task
        Task { await store.rowDuplicate(task, withSubtasks: withSubtasks) }
    }
}

/// Today, Tomorrow, Next week, Remove date.
struct TaskRescheduleButtons: View {
    let task: TaskItem
    let store: TasksStore

    var body: some View {
        ForEach(TaskRescheduleOption.allCases) { option in
            if option != .removeDate || task.dueDate != nil {
                Button {
                    let task = task
                    Task { await store.rowReschedule(task, to: option) }
                } label: {
                    Label(option.title, systemImage: option.symbol)
                }
                .accessibilityIdentifier("tasks.row.reschedule.\(option.rawValue)")
            }
        }
    }
}

/// The context menu's content.
private struct TaskRowMenu: View {
    let task: TaskItem
    let store: TasksStore
    let duplicate: () -> Void
    let pickParent: () -> Void
    let delete: () -> Void

    var body: some View {
        Section(TasksCopy.rowReschedule) {
            TaskRescheduleButtons(task: task, store: store)
        }
        Section {
            projectMenu
            statusMenu
        }
        Section {
            Button(action: duplicate) {
                Label(TasksCopy.rowDuplicate, systemImage: "plus.square.on.square")
            }
            .accessibilityIdentifier("tasks.row.menu.duplicate")
            if store.rowCanBecomeSubtask(task) {
                Button(action: pickParent) {
                    Label(TasksCopy.rowMakeSubtaskOf, systemImage: "arrow.turn.down.right")
                }
                .accessibilityIdentifier("tasks.row.menu.makeSubtask")
            }
            Button {
                let task = task
                Task { await store.rowToggleArchive(task) }
            } label: {
                Label(
                    task.archivedAt == nil ? TasksCopy.rowArchive : TasksCopy.rowUnarchive,
                    systemImage: task.archivedAt == nil ? "archivebox" : "tray.and.arrow.up"
                )
            }
            .accessibilityIdentifier("tasks.row.menu.archive")
        }
        Button(role: .destructive, action: delete) {
            Label(TasksCopy.rowDelete, systemImage: "trash")
        }
        .accessibilityIdentifier("tasks.row.menu.delete")
    }

    @ViewBuilder private var projectMenu: some View {
        let targets = store.rowMoveTargets()
        if !targets.isEmpty {
            Menu {
                ForEach(targets, id: \.id) { project in
                    Button {
                        let task = task
                        Task { await store.rowMove(task, to: project) }
                    } label: {
                        Text(project.name)
                        if project.id == task.projectId { Text(TasksCopy.rowCurrent) }
                    }
                    .disabled(project.id == task.projectId)
                }
            } label: {
                Label(TasksCopy.rowMoveToProject, systemImage: "folder")
            }
            .accessibilityIdentifier("tasks.row.menu.moveToProject")
        }
    }

    @ViewBuilder private var statusMenu: some View {
        let statuses = store.rowStatuses(task)
        if !statuses.isEmpty {
            Menu {
                ForEach(statuses, id: \.id) { status in
                    Button {
                        let task = task
                        Task { await store.rowSetStatus(task, to: status) }
                    } label: {
                        Text(status.name)
                        if status.id == task.statusId { Text(TasksCopy.rowCurrent) }
                    }
                    .disabled(status.id == task.statusId)
                }
            } label: {
                Label(TasksCopy.rowChangeStatus, systemImage: "circle.dashed")
            }
            .accessibilityIdentifier("tasks.row.menu.changeStatus")
        }
    }
}
