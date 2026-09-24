import MemryCore
import SwiftUI

// TP040 / TP050. The list itself: one List section per core group (or the
// flat list), subtasks one level in under their parents, the Done section
// last, and Today's progress on top.
//
// **Drag.** Each section's `onMove` reorders inside that section and writes
// the order (TaskListOrders + positions). A row also offers its ids to drag
// out (`itemProvider`, which leaves the List's own reordering intact), and a
// due-date group's header takes a drop and reschedules (`handleSectionDrop`).
// In edit mode, dragging a selected row moves the whole selected set.

struct TaskListBody: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    let addTask: () -> Void

    @Environment(\.editMode) private var editMode

    /// Selection only exists in edit mode: outside it a tap opens the task,
    /// and a bound selection would keep the tapped row highlighted and carry
    /// it into the next drag or Select.
    private var isEditing: Bool { editMode?.wrappedValue.isEditing == true }

    private var listSelection: Binding<Set<String>> {
        isEditing ? $selection : .constant([])
    }

    var body: some View {
        let sections = store.listSections()
        List(selection: listSelection) {
            if let progress = store.todayProgress {
                TaskTodayProgress(done: progress.done, total: progress.total)
                    .listRowSeparator(.hidden)
            }
            if let empty = store.listEmptyState {
                TaskListEmptyView(
                    state: empty,
                    addTask: addTask,
                    clearFilters: { Task { await store.clearListFilters() } }
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Tokens.Canvas.background.color)
            }
            ForEach(sections) { section in
                listSection(section)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .refreshable { await store.sync() }
        .accessibilityIdentifier("tasks.list")
    }

    @ViewBuilder
    private func listSection(_ section: TaskListSection) -> some View {
        if section.title == nil {
            Section { rows(section) }
        } else {
            Section {
                rows(section)
            } header: {
                TaskListGroupHeader(store: store, section: section)
            }
        }
    }

    private func rows(_ section: TaskListSection) -> some View {
        ForEach(section.rows) { row in
            if let task = store.items[row.id] {
                TaskRowView(task: task, store: store, depth: row.depth)
                    .tag(row.id)
                    .moveDisabled(row.depth > 0)
                    .itemProvider {
                        TaskDragPayload.itemProvider(store.dragIds(for: row.id, selection: isEditing ? selection : []))
                    }
                    .modifier(TaskRowMoveActions(store: store, section: section, row: row))
            }
        }
        .onMove { source, destination in
            let selected = isEditing ? selection : []
            Task { await store.moveRows(in: section, from: source, to: destination, selection: selected) }
        }
    }
}

/// A group's header: its label and count, a tap to fold it (remembered in
/// `collapsedGroups`), and — for a due-date group — a drop target that
/// reschedules what lands on it.
struct TaskListGroupHeader: View {
    let store: TasksStore
    let section: TaskListSection

    @State private var isTargeted = false

    var body: some View {
        let label = section.title ?? ""
        Button {
            store.toggleGroup(section.id)
        } label: {
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: section.isCollapsed ? "chevron.forward" : "chevron.down")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(minWidth: Tokens.Space.inset)
                    .accessibilityHidden(true)
                Text(label)
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(titleColor)
                Text("\(section.count)")
                    .font(Tokens.Typography.caption.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.tertiary.color)
                Spacer(minLength: 0)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .padding(.horizontal, Tokens.Space.small)
            .background(
                isTargeted ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.background.color,
                in: .rect(cornerRadius: Tokens.Radius.control)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .calmAnimation(.fast, value: isTargeted)
        .accessibilityLabel(
            TasksCopy.groupAccessibility(label, count: section.count, collapsed: section.isCollapsed)
        )
        .accessibilityHint(section.dropBucket == nil ? TasksCopy.expandHint : TasksCopy.dropHint)
        .accessibilityIdentifier("tasks.group.\(section.id)")
        .modifier(TaskListDropTarget(store: store, bucket: section.dropBucket, isTargeted: $isTargeted))
    }

    private var titleColor: Color {
        section.kind == .overdue || section.id == "overdue"
            ? Tokens.Task.dueOverdue.color
            : Tokens.Text.secondary.color
    }
}

/// VoiceOver's way to reorder a top-level row without dragging.
private struct TaskRowMoveActions: ViewModifier {
    let store: TasksStore
    let section: TaskListSection
    let row: TaskListRow

    func body(content: Content) -> some View {
        let tops = section.rows.enumerated().filter { $0.element.depth == 0 }.map(\.offset)
        let place = tops.firstIndex { section.rows[$0].id == row.id }
        if row.depth == 0, let place {
            let index = tops[place]
            content
                .accessibilityAction(named: TasksCopy.moveUp) {
                    guard place > 0 else { return }
                    move(index, to: tops[place - 1])
                }
                .accessibilityAction(named: TasksCopy.moveDown) {
                    guard place + 1 < tops.count else { return }
                    let after = place + 2 < tops.count ? tops[place + 2] : section.rows.count
                    move(index, to: after)
                }
        } else {
            content
        }
    }

    private func move(_ index: Int, to destination: Int) {
        Task { await store.moveRows(in: section, from: IndexSet(integer: index), to: destination) }
    }
}

/// A due-date header that takes dropped tasks; nothing for other headers.
private struct TaskListDropTarget: ViewModifier {
    let store: TasksStore
    let bucket: TaskDueBucket?
    @Binding var isTargeted: Bool

    func body(content: Content) -> some View {
        if let bucket {
            content.dropDestination(for: String.self) { texts, _ in
                let ids = texts.flatMap(TaskDragPayload.decode)
                guard !ids.isEmpty else { return false }
                Task { await store.reschedule(ids, to: bucket) }
                return true
            } isTargeted: { isTargeted = $0 }
        } else {
            content
        }
    }
}
