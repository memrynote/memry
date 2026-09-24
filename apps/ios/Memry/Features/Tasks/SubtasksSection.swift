import MemryCore
import SwiftUI

// TP046. The subtasks of a task, after desktop's detail drawer "Sub-issues"
// block (`task-detail-drawer.tsx:590-678`), `sortable-subtask-list.tsx` and
// `add-subtask-input.tsx`: a header with the done count, the add button and the
// bulk menu; one row per subtask; an inline add field that stays focused for
// rapid entry.
//
// It is a `Section`, so inside a `List` or `Form` its rows are real rows (with
// drag-to-reorder through `onMove`) and inside a stack it lays out as a column.
// Reorder is also offered as Move up / Move down, for VoiceOver and for hosts
// that are not lists.

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
            }
            .onMove { source, destination in
                var ids = subtasks.map(\.id)
                ids.move(fromOffsets: source, toOffset: destination)
                Task { await store.reorderSubtasks(ids) }
            }
            if isAdding {
                SubtaskAddField(parent: parent, store: store, isActive: $isAdding)
            } else if subtasks.isEmpty {
                Text(TasksCopy.subtasksEmpty)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        } header: {
            SubtasksHeader(parent: parent, subtasks: subtasks, store: store, isAdding: $isAdding)
        }
    }
}

/// "Sub-issues  2 / 5  [+] […]".
private struct SubtasksHeader: View {
    let parent: TaskItem
    let subtasks: [TaskItem]
    let store: TasksStore
    @Binding var isAdding: Bool

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(TasksCopy.subtasksTitle)
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Tokens.Space.small)
            if !subtasks.isEmpty {
                let done = subtasks.filter(\.isDone).count
                Text(TasksCopy.subtaskCount(done: done, total: subtasks.count))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(TasksCopy.subtaskCountLabel(done: done, total: subtasks.count))
                SubtaskBulkMenu(parent: parent, subtasks: subtasks, store: store)
            }
            Button {
                isAdding = true
            } label: {
                Image(systemName: "plus")
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.Text.secondary.color)
            .accessibilityLabel(TasksCopy.subtaskAdd)
            .accessibilityIdentifier("tasks.subtasks.add")
        }
        .textCase(nil)
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
