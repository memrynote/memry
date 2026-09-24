import MemryCore
import SwiftUI

// TP049. One kanban card (desktop `kanban-card.tsx`): title, then priority,
// due, repeat, project (when the board spans projects), subtask progress,
// linked notes and, on a done card, when it was completed. Tap opens the
// task; long-press drags it to another column or opens the menu. The menu and
// the VoiceOver actions offer the same moves without dragging.

struct KanbanCardView: View {
    let store: TasksStore
    let task: TaskItem
    let column: KanbanColumn
    let allColumns: [KanbanColumn]
    let onMove: (KanbanColumn) -> Void

    private var isDone: Bool { task.isDone || column.isDoneColumn }
    private var otherColumns: [KanbanColumn] {
        allColumns.filter { $0.id != column.id && $0.acceptsMove }
    }

    var body: some View {
        NavigationLink(value: TasksRoute.task(task.id)) {
            content
        }
        .buttonStyle(.plain)
        .draggable(task.id) {
            Text(task.title)
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(Tokens.Space.medium)
                .background(Tokens.Canvas.background.color, in: .rect(cornerRadius: Tokens.Radius.control))
        }
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityHint(TasksCopy.kanbanOpen)
        .accessibilityActions { actions }
        .accessibilityIdentifier("tasks.kanban.card.\(task.id)")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(task.title)
                .font(Tokens.Typography.label.font)
                .foregroundStyle(isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .strikethrough(isDone)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            KanbanCardMeta(store: store, task: task, isDone: isDone)
        }
        .padding(.horizontal, Tokens.Space.medium)
        .padding(.vertical, Tokens.Space.small)
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .background(
            isDone ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.background.color,
            in: .rect(cornerRadius: Tokens.Radius.control)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        }
        .contentShape(.rect)
    }

    @ViewBuilder private var menu: some View {
        Button(task.isDone ? TasksCopy.kanbanReopen : TasksCopy.kanbanComplete,
               systemImage: task.isDone ? "circle" : "checkmark.circle") {
            complete()
        }
        if !otherColumns.isEmpty {
            Menu(TasksCopy.kanbanMoveTo, systemImage: "arrow.forward.square") {
                ForEach(otherColumns) { target in
                    Button(target.title) { onMove(target) }
                }
            }
        }
        Button(TasksCopy.kanbanDelete, systemImage: "trash", role: .destructive) {
            let item = task
            Task { await store.requestDelete(item) }
        }
    }

    @ViewBuilder private var actions: some View {
        Button(task.isDone ? TasksCopy.kanbanReopen : TasksCopy.kanbanComplete) { complete() }
        ForEach(otherColumns) { target in
            Button(TasksCopy.kanbanMoveAction(target.title)) { onMove(target) }
        }
        Button(TasksCopy.kanbanDelete) {
            let item = task
            Task { await store.requestDelete(item) }
        }
    }

    private func complete() {
        let item = task
        Task { await store.requestComplete(item) }
    }
}

/// The card's metadata row.
private struct KanbanCardMeta: View {
    let store: TasksStore
    let task: TaskItem
    let isDone: Bool

    var body: some View {
        let subtasks = store.subtasks(of: task.id)
        FlowLayout(spacing: Tokens.Space.small) {
            if task.priority > 0, !isDone {
                Chip(text: TasksCopy.priorityLabel(task.priority), color: Tokens.Task.priority(task.priority).color)
                    .accessibilityLabel(TasksCopy.kanbanPriority(task.priority))
            }
            if !isDone, let due = store.dueLabel(task) {
                TaskDueBadge(label: due)
            }
            if task.isRepeating, task.repeat != nil {
                TaskRepeatIndicator(rule: task.repeat)
            }
            if store.state.projectId == nil, let project = store.project(task.projectId) {
                TaskProjectChip(name: project.name, color: project.color)
            }
            if !subtasks.isEmpty {
                TaskSubtaskProgress(done: subtasks.filter(\.isDone).count, total: subtasks.count)
            }
            if !task.linkedNoteIds.isEmpty {
                Label("\(task.linkedNoteIds.count)", systemImage: "link")
                    .labelStyle(.titleAndIcon)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(TasksCopy.kanbanLinkedNotes(task.linkedNoteIds.count))
            }
            if isDone, let completed = completedText {
                Text(completed)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(TasksCopy.kanbanCompletedAgo(completed))
            }
        }
    }

    /// Desktop's `formatCompletionTime`: "Just now", else how long ago.
    private var completedText: String? {
        guard let stamp = task.completedAt, let date = Self.instant(stamp) else { return nil }
        let now = store.clock()
        if now.timeIntervalSince(date) < 60 { return TasksCopy.kanbanJustNow }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// A stored ISO instant, with or without fractional seconds.
    private static func instant(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(text, strategy: .iso8601)
    }
}
