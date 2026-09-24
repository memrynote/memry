import MemryCore
import SwiftUI

// TP046. One subtask (`sortable-subtask-row.tsx`): the status circle completes
// or reopens it through `requestComplete` (so the last one can offer to close
// the parent), the title opens it, and the menu, swipe and VoiceOver actions
// promote, reorder and delete.

struct SubtaskRow: View {
    let subtask: TaskItem
    let store: TasksStore
    var canMoveUp = false
    var canMoveDown = false

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Button {
                Task { await store.requestComplete(subtask) }
            } label: {
                TaskStatusIcon(
                    statusType: subtask.statusType,
                    isDone: subtask.isDone,
                    color: statusColor
                )
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.success, trigger: subtask.isDone) { _, done in done }
            .accessibilityLabel(subtask.isDone ? TasksCopy.subtaskReopen : TasksCopy.subtaskComplete)
            .accessibilityIdentifier("tasks.subtask.toggle.\(subtask.id)")

            NavigationLink(value: TasksRoute.task(subtask.id)) {
                SubtaskRowTitle(subtask: subtask, store: store)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(TasksCopy.subtaskRowLabel(subtask.title, isDone: subtask.isDone))
            .accessibilityIdentifier("tasks.subtask.open.\(subtask.id)")
        }
        .contextMenu { menu }
        .swipeActions(edge: .trailing) {
            Button(TasksCopy.subtaskDelete, systemImage: "trash", role: .destructive) {
                Task { await store.requestDelete(subtask) }
            }
            Button(TasksCopy.subtaskPromote, systemImage: "arrow.up.left") {
                Task { await store.promoteToTask(subtask) }
            }
        }
        .accessibilityActions { actions }
    }

    private var statusColor: Color? {
        guard let id = subtask.statusId,
              let status = store.project(subtask.projectId)?.statuses.first(where: { $0.id == id })
        else { return nil }
        return Tokens.Palette.color(status.color)
    }

    @ViewBuilder private var menu: some View {
        NavigationLink(value: TasksRoute.task(subtask.id)) {
            Label(TasksCopy.subtaskOpen, systemImage: "arrow.forward")
        }
        Button(TasksCopy.subtaskPromote, systemImage: "arrow.up.left") {
            Task { await store.promoteToTask(subtask) }
        }
        if canMoveUp {
            Button(TasksCopy.subtaskMoveUp, systemImage: "arrow.up") { move(-1) }
        }
        if canMoveDown {
            Button(TasksCopy.subtaskMoveDown, systemImage: "arrow.down") { move(1) }
        }
        Divider()
        Button(TasksCopy.subtaskDelete, systemImage: "trash", role: .destructive) {
            Task { await store.requestDelete(subtask) }
        }
    }

    @ViewBuilder private var actions: some View {
        Button(subtask.isDone ? TasksCopy.subtaskReopen : TasksCopy.subtaskComplete) {
            Task { await store.requestComplete(subtask) }
        }
        Button(TasksCopy.subtaskPromote) { Task { await store.promoteToTask(subtask) } }
        if canMoveUp { Button(TasksCopy.subtaskMoveUp) { move(-1) } }
        if canMoveDown { Button(TasksCopy.subtaskMoveDown) { move(1) } }
        Button(TasksCopy.subtaskDelete) { Task { await store.requestDelete(subtask) } }
    }

    private func move(_ offset: Int) {
        guard let parentId = subtask.parentId else { return }
        Task { await store.moveSubtask(subtask.id, of: parentId, by: offset) }
    }
}

/// The title with the subtask's due date and priority beside it.
private struct SubtaskRowTitle: View {
    let subtask: TaskItem
    let store: TasksStore

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(subtask.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(subtask.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .strikethrough(subtask.isDone)
                .frame(maxWidth: .infinity, alignment: .leading)
            TaskPriorityIcon(priority: subtask.priority)
            if let due = store.dueLabel(subtask) {
                TaskDueBadge(label: due)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
    }
}
