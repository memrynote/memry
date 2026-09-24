import MemryCore
import SwiftUI

// TP040 / TP050, redesigned (RD01, RD20). The list (Paper artboard 01): one
// section per core group (or the flat list, split under an Overdue header on
// Today and Next 7), subtasks one level in under their parents, and the
// Completed section last, collapsed by default. Headers are quiet text with a
// count; the Overdue header takes the overdue colour.
//
// **Drag.** One `onMove` over the whole list (headers are rows, see
// `TaskListFlatItem`): a move inside a group reorders it and writes the order
// (TaskListOrders + positions); a move into another due-date group reschedules
// (`handleSectionDrop`). In select mode, dragging a selected row moves the
// whole selected set. A header also takes drops from outside the List.

struct TaskListBody<Header: View>: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    @Binding var titleCollapsed: Bool
    @ViewBuilder let header: () -> Header

    @Environment(\.editMode) private var editMode
    @Environment(\.taskOpenComposer) private var openComposer

    /// Selection only exists in select mode. The page owns it, not the List:
    /// a List that holds a multi-selection turns a drag into a drag session
    /// and never calls `onMove`, so moving a selected set would do nothing.
    private var isEditing: Bool { editMode?.wrappedValue.isEditing == true }

    var body: some View {
        let sections = store.listSections().filter { $0.kind != .done || store.showsCompleted }
        List {
            header()
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(
                    top: Tokens.Space.tight, leading: TaskLayout.edge,
                    bottom: Tokens.Space.small, trailing: TaskLayout.edge
                ))
                .moveDisabled(true)
            if let failure = store.failure {
                TaskListFailureRow(failure: failure) { store.clearFailure() }
                    .listRowSeparator(.hidden)
            }
            if let empty = store.listEmptyState {
                TaskListEmptyView(
                    state: empty,
                    next: store.listEmptyNext,
                    addTask: { openComposer?(TaskComposerRequest(projectId: store.state.projectId, dueDate: store.emptyStateDue)) },
                    show: { tab in Task { await store.selectTab(tab) } },
                    clearFilters: { Task { await store.clearListFilters() } }
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Tokens.Canvas.background.color)
            }
            rows(sections)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .scrollDismissesKeyboard(.interactively)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .refreshable { await store.sync() }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea
        } action: { _, collapsed in
            titleCollapsed = collapsed
        }
        .accessibilityIdentifier("tasks.list")
    }

    private func rows(_ sections: [TaskListSection]) -> some View {
        let items = TaskListFlatItem.items(sections)
        return ForEach(items) { item in
            if let row = item.row {
                if let task = store.items[row.id] {
                    TaskRowView(
                        task: task,
                        store: store,
                        depth: row.depth,
                        context: context(for: sections[item.section], depth: row.depth),
                        selection: isEditing ? TaskRowSelection(
                            isSelected: selection.contains(row.id),
                            toggle: { toggle(row.id) }
                        ) : nil
                    )
                    .tag(row.id)
                    .moveDisabled(row.depth > 0)
                    .modifier(TaskRowMoveActions(store: store, section: sections[item.section], row: row))
                }
            } else {
                TaskListGroupHeader(store: store, section: sections[item.section])
                    .moveDisabled(true)
                    .selectionDisabled()
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(
                        top: 0, leading: TaskLayout.edge, bottom: 0, trailing: TaskLayout.edge
                    ))
            }
        }
        .onMove { source, destination in
            let selected = isEditing ? selection : []
            switch TaskListMove.resolve(items, sections: sections, from: source, to: destination) {
            case let .reorder(index, from, to):
                Task { await store.moveRows(in: sections[index], from: from, to: to, selection: selected) }
            case let .reschedule(index, ids):
                guard let bucket = sections[index].dropBucket, let first = ids.first else { return }
                let moving = selected.contains(first) ? store.dragIds(for: first, selection: selected) : ids
                Task { await store.reschedule(moving, to: bucket) }
            case .none:
                break
            }
        }
    }

    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }

    /// What a row may leave out because the screen already says it.
    private func context(for section: TaskListSection, depth: Int) -> TaskMeta.Context {
        TaskMeta.Context(
            omitsDay: store.sectionNamesDay(section),
            showsProject: depth == 0 && store.state.projectId == nil
        )
    }
}

extension TasksStore {
    /// Whether a section's header (or the view) already names the day its
    /// rows are due: the Today and Tomorrow views, and Today / Tomorrow groups.
    func sectionNamesDay(_ section: TaskListSection) -> Bool {
        if section.kind == .group {
            return state.sort.field == "dueDate" && (section.id == "today" || section.id == "tomorrow")
        }
        guard section.kind == .flat || section.kind == .done else { return false }
        return state.tab == .today || state.tab == .tomorrow
    }

    /// The due date "Add task for today/tomorrow" starts with, resolved by
    /// the core's date parser against the local clock.
    var emptyStateDue: String? {
        let phrase: String? = switch state.tab {
        case .today: "today"
        case .tomorrow: "tomorrow"
        case .all, .next7, .archived: nil
        }
        return phrase.flatMap { parseTaskDate(input: $0, now: localNow())?.date }
    }
}

/// A group's header: its label and count, a tap to fold it (remembered in
/// `collapsedGroups`), and, for a due-date group, a drop target that
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
                if section.isCollapsed {
                    Image(systemName: "chevron.forward")
                        .font(Tokens.Typography.caption.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .accessibilityHidden(true)
                }
                Text(label)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(titleColor)
                Text("\(section.count)")
                    .font(Tokens.Typography.caption.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.tertiary.color)
                Spacer(minLength: 0)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(isTargeted ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.background.color)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .calmAnimation(.fast, value: isTargeted)
        .accessibilityLabel(
            TasksCopy.groupAccessibility(label, count: section.count, collapsed: section.isCollapsed)
        )
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(section.dropBucket == nil ? TasksCopy.expandHint : TasksCopy.dropHint)
        .accessibilityIdentifier("tasks.group.\(section.id)")
        .modifier(TaskListDropTarget(store: store, bucket: section.dropBucket, isTargeted: $isTargeted))
    }

    private var titleColor: Color {
        if section.kind == .overdue || section.id == "overdue" || section.id == "dueDate.overdue" {
            return Tokens.Task.dueOverdue.color
        }
        return section.kind == .done ? Tokens.Text.tertiary.color : Tokens.Text.primary.color
    }
}

/// A failed write, above the rows, with its own dismiss.
private struct TaskListFailureRow: View {
    let failure: UserFacingError
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.small) {
            ErrorNotice(error: failure, code: nil)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.Text.secondary.color)
            .accessibilityLabel(TasksCopy.dismissError)
            .accessibilityIdentifier("tasks.error.dismiss")
        }
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
