import MemryCore
import SwiftUI

// TP049, redesigned (RD16). One kanban column (desktop `kanban-column.tsx`):
// a surface panel that hugs its cards (the board scrolls vertically), a
// header with the column's mark, name, count and "+", the cards, the done
// column's fold after the first five, an inline title field for "+", and a
// drop target.

struct KanbanColumnView: View {
    let store: TasksStore
    let lane: KanbanLane
    let allColumns: [KanbanColumn]
    let onDrop: (String, KanbanColumn) -> Void

    /// Desktop's `MAX_VISIBLE_DONE`.
    static let maxVisibleDone = 5

    @State private var showAllDone = false
    @State private var isAdding = false
    @State private var newTitle = ""
    @State private var isTargeted = false
    @FocusState private var addFocused: Bool

    private var column: KanbanColumn { lane.column }

    private var visibleTasks: [TaskItem] {
        guard column.isDoneColumn, !showAllDone else { return lane.tasks }
        return Array(lane.tasks.prefix(Self.maxVisibleDone))
    }

    private var hiddenCount: Int { lane.tasks.count - visibleTasks.count }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            KanbanColumnHeader(column: column, count: lane.tasks.count, onAdd: startAdding)
            if visibleTasks.isEmpty, !isAdding {
                KanbanEmptyColumn(column: column, isTargeted: isTargeted)
            }
            ForEach(visibleTasks, id: \.id) { task in
                KanbanCardView(
                    store: store,
                    task: task,
                    column: column,
                    allColumns: allColumns,
                    onMove: { target in onDrop(task.id, target) }
                )
            }
            foldButtons
            if isAdding { addField }
        }
        .padding(Tokens.Space.small)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.container))
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.container)
                .strokeBorder(isTargeted ? Tokens.Line.focus.color : .clear, lineWidth: Tokens.Size.hairline)
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, column.acceptsMove else { return false }
            onDrop(id, column)
            return true
        } isTargeted: { isTargeted = $0 }
        .calmAnimation(.fast, value: isTargeted)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.kanbanColumnSummary(column.title, count: lane.tasks.count))
        .accessibilityIdentifier("tasks.kanban.column.\(column.id)")
    }

    @ViewBuilder private var foldButtons: some View {
        if hiddenCount > 0 {
            foldButton(TasksCopy.kanbanMoreCompleted(hiddenCount), id: "showMore") { showAllDone = true }
        } else if showAllDone, column.isDoneColumn, lane.tasks.count > Self.maxVisibleDone {
            foldButton(TasksCopy.kanbanShowFewer, id: "showFewer") { showAllDone = false }
        }
    }

    private func foldButton(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
            .buttonStyle(.plain)
            .accessibilityIdentifier("tasks.kanban.\(id).\(column.id)")
    }

    private var addField: some View {
        TextField(TasksCopy.kanbanTaskTitle, text: $newTitle)
            .font(Tokens.Typography.body.font)
            .focused($addFocused)
            .submitLabel(.done)
            .onSubmit(submit)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(Tokens.Canvas.background.color, in: .rect(cornerRadius: Tokens.Radius.control))
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                    .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            }
            .onAppear { addFocused = true }
            .onChange(of: addFocused) { _, focused in
                if !focused { submit() }
            }
            .accessibilityLabel(TasksCopy.kanbanTaskTitle)
            .accessibilityIdentifier("tasks.kanban.addField.\(column.id)")
    }

    /// Opens the title field; it takes focus when it appears.
    private func startAdding() {
        isAdding = true
    }

    /// Desktop submits on Return and on blur, and closes the field either way.
    private func submit() {
        let title = newTitle
        newTitle = ""
        isAdding = false
        addFocused = false
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let target = column
        Task { await store.kanbanAdd(title: title, to: target) }
    }
}

/// The column's mark, name, count and "+".
private struct KanbanColumnHeader: View {
    let column: KanbanColumn
    let count: Int
    let onAdd: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            mark
            Text(column.title)
                .font(Tokens.Typography.label.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1)
            Text("\(count)")
                .font(Tokens.Typography.label.font)
                .monospacedDigit()
                .foregroundStyle(Tokens.Text.tertiary.color)
            Spacer(minLength: Tokens.Space.small)
            if column.acceptsAdd {
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(Tokens.Typography.label.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.kanbanAddTo(column.title))
                .accessibilityIdentifier("tasks.kanban.add.\(column.id)")
            }
        }
        .padding(.leading, Tokens.Space.tight)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var mark: some View {
        switch column.target {
        case let .statusType(type):
            TaskStatusIcon(statusType: type, isDone: type == "done", scale: .small)
        case let .status(_, _, type, _):
            TaskStatusIcon(statusType: type, isDone: type == "done", color: column.tint, scale: .small)
        case let .priority(value) where value > 0:
            TaskPriorityIcon(priority: value)
        default:
            Circle()
                .fill(column.tint)
                .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                .accessibilityHidden(true)
        }
    }
}

/// An empty column (desktop `kanban-empty-column.tsx`), or the drop hint
/// while a card hovers over it.
private struct KanbanEmptyColumn: View {
    let column: KanbanColumn
    let isTargeted: Bool

    var body: some View {
        VStack(spacing: Tokens.Space.tight) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            Text(isTargeted ? TasksCopy.kanbanDropHere : column.emptyCopy.title)
                .font(Tokens.Typography.caption.font.weight(.medium))
                .foregroundStyle(Tokens.Text.secondary.color)
            if !isTargeted {
                Text(column.emptyCopy.subtitle)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(Tokens.Space.section)
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                .strokeBorder(
                    isTargeted ? Tokens.Line.focus.color : Tokens.Line.border.color,
                    style: StrokeStyle(lineWidth: Tokens.Size.hairline, dash: [Tokens.Space.tight])
                )
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        if isTargeted { return "square.and.arrow.down" }
        if column.isDoneColumn { return "checkmark" }
        if case .due = column.target { return "calendar" }
        return "plus"
    }
}
