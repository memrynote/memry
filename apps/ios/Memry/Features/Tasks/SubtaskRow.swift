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

    /// A subtask row sits under the title's text column (Paper: the status
    /// lane starts where the detail's text starts).
    static var insets: EdgeInsets {
        EdgeInsets(
            top: 0, leading: TaskDetailLayout.bodyLeading - Tokens.Space.tight,
            bottom: 0, trailing: TaskLayout.edge
        )
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            TaskStatusLane(
                action: { Task { await store.requestComplete(subtask) } },
                label: subtask.isDone ? TasksCopy.subtaskReopen : TasksCopy.subtaskComplete,
                identifier: "tasks.subtask.toggle.\(subtask.id)"
            ) {
                TaskStatusIcon(statusType: subtask.statusType, isDone: subtask.isDone, color: statusColor, scale: .medium)
            }
            .sensoryFeedback(.success, trigger: subtask.isDone) { _, done in done }

            NavigationLink(value: TasksRoute.task(subtask.id)) {
                SubtaskRowTitle(subtask: subtask, store: store)
            }
            .navigationLinkIndicatorVisibility(.hidden)
            .accessibilityLabel(TasksCopy.subtaskRowLabel(subtask.title, isDone: subtask.isDone))
            .accessibilityIdentifier("tasks.subtask.open.\(subtask.id)")
        }
        .contextMenu { menu }
        .swipeActions(edge: .trailing) {
            Button(TasksCopy.subtaskDelete, systemImage: "trash", role: .destructive) {
                Task { await store.requestDelete(subtask) }
            }
            Button(TasksCopy.subtaskPromote, systemImage: "arrow.up.backward") {
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
        Button(TasksCopy.subtaskPromote, systemImage: "arrow.up.backward") {
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

/// The title with the subtask's due date and priority beside it (Paper: the
/// callout step, done titles in the tertiary ink).
private struct SubtaskRowTitle: View {
    let subtask: TaskItem
    let store: TasksStore

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(subtask.title)
                .font(Tokens.Typography.label.font.weight(.regular))
                .foregroundStyle(subtask.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            TaskPriorityIcon(priority: subtask.priority)
            if !subtask.isDone, let due = store.dueLabel(subtask) {
                TaskDueBadge(label: due)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
    }
}
