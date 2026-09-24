import MemryCore
import SwiftUI

// TP046. The subtask bulk menu (`lib/subtask-bulk-utils.ts` and the
// `bulk-due-date-dialog.tsx` / `bulk-priority-dialog.tsx` /
// `delete-all-subtasks-dialog.tsx` dialogs): complete all, mark all incomplete,
// due date and priority for all (with "also apply to completed"), delete all.

struct SubtaskBulkMenu: View {
    let parent: TaskItem
    let subtasks: [TaskItem]
    let store: TasksStore

    @State private var isSettingDue = false
    @State private var isSettingPriority = false
    @State private var isConfirmingDelete = false

    var body: some View {
        Menu {
            Button(TasksCopy.subtaskCompleteAll, systemImage: "checkmark.circle") {
                Task { await store.completeAllSubtasks(of: parent.id) }
            }
            .disabled(subtasks.allSatisfy(\.isDone))
            .accessibilityIdentifier("tasks.subtasks.bulk.completeAll")
            Button(TasksCopy.subtaskMarkAllIncomplete, systemImage: "circle") {
                Task { await store.markAllSubtasksIncomplete(of: parent.id) }
            }
            .disabled(!subtasks.contains(where: \.isDone))
            .accessibilityIdentifier("tasks.subtasks.bulk.incompleteAll")
            Button(TasksCopy.subtaskSetDueForAll, systemImage: "calendar") { isSettingDue = true }
                .accessibilityIdentifier("tasks.subtasks.bulk.due")
            Button(TasksCopy.subtaskSetPriorityForAll, systemImage: "flag") { isSettingPriority = true }
                .accessibilityIdentifier("tasks.subtasks.bulk.priority")
            Divider()
            Button(TasksCopy.subtaskDeleteAllAction, systemImage: "trash", role: .destructive) {
                isConfirmingDelete = true
            }
            .accessibilityIdentifier("tasks.subtasks.bulk.deleteAll")
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .foregroundStyle(Tokens.Text.secondary.color)
        .accessibilityLabel(TasksCopy.subtaskBulkMenu)
        .accessibilityIdentifier("tasks.subtasks.bulkMenu")
        .sheet(isPresented: $isSettingDue) {
            SubtaskBulkDueSheet(parent: parent, completedCount: completedCount, store: store)
        }
        .sheet(isPresented: $isSettingPriority) {
            SubtaskBulkPrioritySheet(
                parent: parent,
                count: subtasks.count,
                completedCount: completedCount,
                store: store
            )
        }
        .confirmationDialog(
            TasksCopy.subtaskDeleteAllTitle,
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button(TasksCopy.subtaskDeleteAllConfirm, role: .destructive) {
                Task { await store.deleteAllSubtasks(of: parent.id) }
            }
            .accessibilityIdentifier("tasks.subtasks.bulk.deleteAllConfirm")
            Button(TasksCopy.subtaskCancel, role: .cancel) {}
        } message: {
            Text(TasksCopy.subtaskDeleteAllMessage(count: subtasks.count, title: parent.title))
        }
    }

    private var completedCount: Int { subtasks.filter(\.isDone).count }
}

/// The date picker (TP044's `TaskDateSheet`) with desktop's "Also apply to
/// completed subtasks (N)" switch under it. The core writes the date only.
struct SubtaskBulkDueSheet: View {
    let parent: TaskItem
    let completedCount: Int
    let store: TasksStore

    @State private var includeCompleted = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        TaskDateSheet(
            title: TasksCopy.subtaskSetDueForAll,
            date: nil,
            time: nil,
            allowsTime: false,
            store: store
        ) { date, _ in
            let include = includeCompleted
            let parentId = parent.id
            dismiss()
            Task { await store.setDueForAllSubtasks(of: parentId, date: date, includeCompleted: include) }
        }
        .safeAreaInset(edge: .bottom) {
            if completedCount > 0 {
                Toggle(TasksCopy.subtaskAlsoApplyToCompleted(completedCount), isOn: $includeCompleted)
                    .font(Tokens.Typography.body.font)
                    .padding(Tokens.Space.inset)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .background(Tokens.Canvas.surface.color)
                    .accessibilityIdentifier("tasks.subtasks.bulk.includeCompleted")
            }
        }
    }
}

/// `bulk-priority-dialog.tsx`.
struct SubtaskBulkPrioritySheet: View {
    let parent: TaskItem
    let count: Int
    let completedCount: Int
    let store: TasksStore

    @State private var priority: Int64 = 0
    @State private var includeCompleted = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(TasksCopy.subtaskSetPriorityForAll, selection: $priority) {
                        ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { value in
                            HStack(spacing: Tokens.Space.small) {
                                TaskPriorityIcon(priority: value)
                                Text(TasksCopy.priorityLabel(value))
                            }
                            .tag(value)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityIdentifier("tasks.subtasks.bulk.priorityPicker")
                } footer: {
                    Text(TasksCopy.subtaskSetPriorityMessage(count: count, title: parent.title))
                }
                if completedCount > 0 {
                    Toggle(TasksCopy.subtaskAlsoApplyToCompleted(completedCount), isOn: $includeCompleted)
                        .accessibilityIdentifier("tasks.subtasks.bulk.priorityIncludeCompleted")
                }
            }
            .navigationTitle(TasksCopy.subtaskSetPriorityForAll)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TasksCopy.subtaskCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TasksCopy.subtaskApply) { apply() }
                        .accessibilityIdentifier("tasks.subtasks.bulk.priorityApply")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func apply() {
        let parentId = parent.id
        let value = priority
        let include = includeCompleted
        dismiss()
        Task { await store.setPriorityForAllSubtasks(of: parentId, priority: value, includeCompleted: include) }
    }
}
