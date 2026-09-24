import MemryCore
import SwiftUI

// TP041, redesigned (RD06, RD07). The row's swipe actions and long-press menu.
//
// **Swipe** (Paper artboard 06): leading completes (or reopens); trailing
// offers Date (the When menu's targets) and Delete. Delete is not confirmed
// here: it goes through `requestDelete`, which asks when a parent has
// subtasks, and the toast offers Undo, as desktop's delete does.
//
// **Long press** (artboard 07, desktop's Move menu): the four reschedule
// targets as a small icon row (Today, Tomorrow, Next week, No date);
// Priority ›, Status › and Move to › as pickers; Duplicate, Make subtask of…,
// Select; Archive (Unarchive) and Delete. The preview is the row itself.
//
// **Duplicate asks only when there are subtasks to copy**
// (`duplicate-with-subtasks-dialog.tsx`); a task without subtasks is copied at
// once.

struct TaskRowActions: ViewModifier {
    let task: TaskItem
    let store: TasksStore
    let complete: () -> Void

    @Environment(\.taskBeginSelection) private var beginSelection
    @State private var isPickingParent = false
    @State private var isConfirmingDuplicate = false
    @State private var isPickingDate = false
    /// The row's width, so the long-press preview is the row's size (a
    /// preview with no finite ideal width crashes UIKit's presentation).
    @State private var rowWidth: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowWidth = $0 }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button(action: complete) {
                    Label(
                        task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete,
                        systemImage: task.isDone ? "arrow.uturn.backward.circle" : "checkmark"
                    )
                }
                .tint(Tokens.Task.complete.color)
                .accessibilityIdentifier("tasks.row.swipe.complete")
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive, action: delete) {
                    Label(TasksCopy.rowDelete, systemImage: "trash")
                }
                .tint(Tokens.Interaction.destructive.color)
                .accessibilityIdentifier("tasks.row.swipe.delete")
                Menu {
                    TaskWhenMenu(store: store, actions: whenActions)
                } label: {
                    Label(TasksCopy.bulkDate, systemImage: "calendar")
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
                    select: beginSelection.map { begin in { begin(task.id) } },
                    delete: delete
                )
            } preview: {
                TaskRowPreview(task: task, store: store)
                    .frame(width: max(rowWidth, Tokens.Size.minimumHitArea))
            }
            .sheet(isPresented: $isPickingParent) {
                ParentPickerSheet(task: task, store: store)
            }
            .sheet(isPresented: $isPickingDate) {
                TaskWhenSheet(store: store, target: .task(task))
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

    private var whenActions: TaskWhenActions {
        let task = task
        return TaskWhenActions(
            date: task.dueDate,
            rule: task.repeat,
            setDate: { date in Task { await store.rowSetDue(task, date: date) } },
            removeDate: { Task { await store.rowReschedule(task, to: .removeDate) } },
            pickDateTime: { isPickingDate = true },
            setRule: nil,
            addReminder: nil
        )
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

/// The long-press menu's content.
private struct TaskRowMenu: View {
    let task: TaskItem
    let store: TasksStore
    let duplicate: () -> Void
    let pickParent: () -> Void
    let select: (() -> Void)?
    let delete: () -> Void

    var body: some View {
        ControlGroup {
            ForEach(TaskRescheduleOption.allCases) { option in
                Button {
                    let task = task
                    Task { await store.rowReschedule(task, to: option) }
                } label: {
                    Label(option.title, systemImage: option.symbol)
                }
                .disabled(option == .removeDate && task.dueDate == nil)
                .accessibilityIdentifier("tasks.row.reschedule.\(option.rawValue)")
            }
        }
        .controlGroupStyle(.compactMenu)

        Section {
            priorityMenu
            statusMenu
            projectMenu
        }
        Section {
            Button(TasksCopy.rowDuplicate, systemImage: "plus.square.on.square", action: duplicate)
                .accessibilityIdentifier("tasks.row.menu.duplicate")
            if store.rowCanBecomeSubtask(task) {
                Button(TasksCopy.rowMakeSubtaskOf, systemImage: "arrow.turn.down.right", action: pickParent)
                    .accessibilityIdentifier("tasks.row.menu.makeSubtask")
            }
            if let select {
                Button(TasksCopy.moreSelect, systemImage: "checkmark.circle", action: select)
                    .accessibilityIdentifier("tasks.row.menu.select")
            }
        }
        Section {
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
            Button(TasksCopy.rowDelete, systemImage: "trash", role: .destructive, action: delete)
                .accessibilityIdentifier("tasks.row.menu.delete")
        }
    }

    private var priorityMenu: some View {
        Menu {
            Picker(TasksCopy.fieldPriority, selection: Binding(
                get: { task.priority },
                set: { value in
                    let task = task
                    Task { await store.detailSetPriority(task, value) }
                }
            )) {
                ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { (value: Int64) in
                    Text(TasksCopy.priorityLabel(value)).tag(value)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Text(TasksCopy.fieldPriority)
            Text(TasksCopy.priorityLabel(task.priority))
        }
        .accessibilityIdentifier("tasks.row.menu.priority")
    }

    @ViewBuilder private var statusMenu: some View {
        let statuses = store.rowStatuses(task)
        if !statuses.isEmpty {
            Menu {
                Picker(TasksCopy.fieldStatus, selection: Binding(
                    get: { task.statusId },
                    set: { id in
                        guard let status = statuses.first(where: { $0.id == id }) else { return }
                        let task = task
                        Task { await store.rowSetStatus(task, to: status) }
                    }
                )) {
                    ForEach(statuses, id: \.id) { status in
                        Label(
                            status.name,
                            systemImage: TaskStatusGlyph.symbol(statusType: status.statusType, isDone: status.isDone)
                        )
                        .tag(Optional(status.id))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Text(TasksCopy.fieldStatus)
                Text(store.rowStatus(task)?.name ?? TasksCopy.statusTypeLabel(task.statusType))
            }
            .accessibilityIdentifier("tasks.row.menu.changeStatus")
        }
    }

    @ViewBuilder private var projectMenu: some View {
        let targets = store.rowMoveTargets()
        if !targets.isEmpty {
            Menu {
                Picker(TasksCopy.rowMoveTo, selection: Binding(
                    get: { task.projectId },
                    set: { id in
                        guard let project = targets.first(where: { $0.id == id }) else { return }
                        let task = task
                        Task { await store.rowMove(task, to: project) }
                    }
                )) {
                    ForEach(targets, id: \.id) { project in
                        Text(project.name).tag(project.id)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Text(TasksCopy.rowMoveTo)
                Text(store.project(task.projectId)?.name ?? "")
            }
            .accessibilityIdentifier("tasks.row.menu.moveToProject")
        }
    }
}

/// The long-press preview: the row alone on its canvas (artboard 07).
private struct TaskRowPreview: View {
    let task: TaskItem
    let store: TasksStore

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            TaskStatusIcon(
                statusType: task.statusType,
                isDone: task.isDone,
                color: store.rowStatus(task).map { Tokens.Palette.color($0.color) }
            )
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(task.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                TaskMetaLine(meta: store.meta(task, context: TaskMeta.Context()))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            TaskPriorityIcon(priority: task.priority)
        }
        .padding(Tokens.Space.inset)
        .background(Tokens.Canvas.background.color)
    }
}
