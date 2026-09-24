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
    /// Accessibility sizes fit fewer words per line, so a title gets more lines.
    @Environment(\.dynamicTypeSize) private var typeSize

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

    /// Paper card: canvas on the column's surface, a hairline edge, the
    /// title and one meta line (the list row's order, RD01) with the priority
    /// bars trailing it; a done card is dimmed and says when it was done.
    private var content: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(task.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .lineLimit(typeSize.isAccessibilitySize ? 6 : 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            KanbanCardMeta(store: store, task: task, isDone: isDone)
        }
        .padding(.horizontal, Tokens.Space.medium)
        .padding(.vertical, Tokens.Space.medium)
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .background(Tokens.Canvas.background.color, in: .rect(cornerRadius: Tokens.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
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

/// The card's one meta line (`TaskMetaLine`, board context: the project
/// only when the board spans projects) and the priority bars; a done card
/// shows when it was completed instead.
private struct KanbanCardMeta: View {
    let store: TasksStore
    let task: TaskItem
    let isDone: Bool

    var body: some View {
        if isDone {
            if let completed = completedText {
                Text(completed)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(TasksCopy.kanbanCompletedAgo(completed))
            }
        } else {
            // Rule 4: a card leaves out what its column already says.
            let mode = store.kanbanEffectiveMode
            let full = store.meta(task, context: TaskMeta.Context(showsProject: store.state.projectId == nil))
            let meta = TaskMeta(items: full.items.filter { item in
                switch item {
                case .due: mode != .dueDate
                case .project: mode != .project
                default: true
                }
            })
            let showsPriority = task.priority > 0 && mode != .priority
            if !meta.isEmpty || showsPriority {
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                    TaskMetaLine(meta: meta)
                    if showsPriority {
                        TaskPriorityIcon(priority: task.priority)
                            .font(Tokens.Typography.caption.font)
                            .accessibilityLabel(TasksCopy.kanbanPriority(task.priority))
                    }
                }
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
