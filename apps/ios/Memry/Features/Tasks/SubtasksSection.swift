import MemryCore
import SwiftUI

// TP046, redesigned (RD08). The subtasks of a task (Paper "Subtasks"):
// "Subtasks 2 of 5" with a progress bar and the bulk menu (desktop's
// `sortable-subtask-list.tsx` and `subtask-bulk-utils.ts`), one row per
// subtask, and an inline "Add subtask" row that stays focused for rapid entry.
// The header only shows when there are subtasks; the add row always does.
//
// Rows are real List rows: drag to reorder (`onMove`), long press for the
// subtask's menu (open, promote, move up / down, delete), swipe to promote or
// delete. Reorder is also offered as Move up / Move down for VoiceOver.

/// TP046 — subtasks of a task.
struct SubtasksSection: View {
    let parent: TaskItem
    let store: TasksStore

    @State private var isAdding = false

    var body: some View {
        let subtasks = store.subtasks(of: parent.id)
        Section {
            ForEach(Array(subtasks.enumerated()), id: \.element.id) { index, subtask in
                SubtaskRow(
                    subtask: subtask,
                    store: store,
                    canMoveUp: index > 0,
                    canMoveDown: index < subtasks.count - 1
                )
                .listRowInsets(SubtaskRow.insets)
            }
            .onMove { source, destination in
                var ids = subtasks.map(\.id)
                ids.move(fromOffsets: source, toOffset: destination)
                Task { await store.reorderSubtasks(ids) }
            }
            SubtaskAddField(parent: parent, store: store, isActive: $isAdding)
                .listRowInsets(SubtaskRow.insets)
                .listRowSeparator(.hidden)
        } header: {
            if !subtasks.isEmpty {
                SubtasksHeader(parent: parent, subtasks: subtasks, store: store)
            }
        }
    }
}

/// "Subtasks  2 of 5 ……… [progress] […]".
private struct SubtasksHeader: View {
    let parent: TaskItem
    let subtasks: [TaskItem]
    let store: TasksStore

    var body: some View {
        let done = subtasks.filter(\.isDone).count
        HStack(spacing: Tokens.Space.small) {
            Text(TasksCopy.subtasksTitle)
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Text(TasksCopy.subtaskCount(done: done, total: subtasks.count))
                .font(Tokens.Typography.caption.font.monospacedDigit())
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityLabel(TasksCopy.subtaskCountLabel(done: done, total: subtasks.count))
            Spacer(minLength: Tokens.Space.small)
            ProgressView(value: Double(done), total: Double(subtasks.count))
                .tint(Tokens.Task.complete.color)
                .frame(maxWidth: Tokens.Size.minimumHitArea + Tokens.Space.section)
                .accessibilityHidden(true)
            SubtaskBulkMenu(parent: parent, subtasks: subtasks, store: store)
        }
        .textCase(nil)
        .padding(.leading, TaskDetailLayout.bodyLeading - TaskLayout.edge)
    }
}

// `ParentPickerSheet` lives in `ParentPickerSheet.swift`, the dialogs in
// `SubtaskPrompts.swift`.
extension View {
    /// TP046 — hosts the complete-parent, all-subtasks-done and delete-parent
    /// dialogs the store raises.
    func subtaskPrompts(store: TasksStore) -> some View {
        modifier(SubtaskPrompts(store: store))
    }
}
