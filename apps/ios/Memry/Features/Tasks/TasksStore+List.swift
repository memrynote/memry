import Foundation
import MemryCore
import SwiftUI

// TP040 / TP050. What the task list draws and the writes it makes, built on
// the core's page answer (`store.result`): which rows, in which sections,
// under which headers. The core decides membership, order and grouping (D5);
// this file only lays its answer out the way desktop's
// `virtualized-all-tasks-view.tsx` and `lib/virtual-list-utils.ts` do:
//
// - top-level rows only, each followed by its subtasks (`getTopLevelTasks`,
//   `getSubtasks`);
// - one section per core group, or one `flat` section when the sort has none;
//   on Today and Next 7 a flat list's leading overdue rows get their own
//   Overdue header;
// - the Done section last, collapsed by default (`collapsedGroups`);
// - desktop's device-local manual order (`task-orders`) over each section.

/// One section of the list.
struct TaskListSection: Identifiable, Equatable {
    enum Kind: Equatable { case flat, group, overdue, done }

    /// The section key desktop uses for its order and collapse state.
    let id: String
    let kind: Kind
    /// `nil` for the flat section, which has no header.
    let title: String?
    let color: String?
    /// Top-level tasks in the section, collapsed or not.
    let count: Int
    let isCollapsed: Bool
    /// The due-date bucket a drop on the header reschedules to.
    let dropBucket: TaskDueBucket?
    /// Empty while collapsed.
    let rows: [TaskListRow]
}

/// Which empty state the list shows.
enum TaskListEmptyState: Equatable {
    case filtered
    case all
    case project(String)
    case today
    case tomorrow
    case next7
    case archived
}

extension TasksStore {
    // MARK: Layout

    /// The list's sections for the current page answer.
    func listSections(orders: TaskListOrders = TaskListOrders()) -> [TaskListSection] {
        guard let result else { return [] }
        _ = scratch[Self.orderRevisionKey]
        let topLevel = result.taskIds.filter { items[$0]?.parentId == nil }
        var sections: [TaskListSection] = []
        if result.groups.isEmpty {
            sections += flatSections(topLevel, orders: orders)
        } else {
            let visible = Set(topLevel)
            for group in result.groups {
                let ids = group.taskIds.filter(visible.contains)
                let title = group.labelKey.map(TasksCopy.groupLabel) ?? group.name ?? group.key
                sections.append(section(
                    id: group.key,
                    kind: .group,
                    title: title,
                    color: group.color,
                    ids: ids,
                    bucket: TaskDueBucket(groupKey: group.key, sortField: state.sort.field),
                    orders: orders
                ))
            }
        }
        let done = result.doneIds.filter { items[$0]?.parentId == nil }
        if !done.isEmpty {
            sections.append(section(
                id: "done", kind: .done, title: TasksCopy.doneGroup, color: nil, ids: done, bucket: nil, orders: orders
            ))
        }
        return sections
    }

    private func flatSections(_ ids: [String], orders: TaskListOrders) -> [TaskListSection] {
        var overdue: [String] = []
        if state.tab == .today || state.tab == .next7 {
            overdue = Array(ids.prefix { id in
                items[id].flatMap(dueLabel)?.tone == .overdue
            })
        }
        let rest = Array(ids.dropFirst(overdue.count))
        var sections: [TaskListSection] = []
        if !overdue.isEmpty {
            sections.append(section(
                id: "overdue", kind: .overdue, title: TasksCopy.overdueGroup, color: nil,
                ids: overdue, bucket: nil, orders: orders
            ))
        }
        if !rest.isEmpty {
            sections.append(section(
                id: "flat", kind: .flat, title: nil, color: nil, ids: rest, bucket: nil, orders: orders
            ))
        }
        return sections
    }

    // swiftlint:disable:next function_parameter_count
    private func section(
        id: String,
        kind: TaskListSection.Kind,
        title: String?,
        color: String?,
        ids: [String],
        bucket: TaskDueBucket?,
        orders: TaskListOrders
    ) -> TaskListSection {
        let collapsed = title != nil && state.collapsedGroups.contains(id)
        let ordered = orders.ordered(ids, section: id)
        return TaskListSection(
            id: id,
            kind: kind,
            title: title,
            color: color,
            count: ids.count,
            isCollapsed: collapsed,
            dropBucket: bucket,
            rows: collapsed ? [] : ordered.flatMap(rowsUnder)
        )
    }

    /// A top-level task and the subtasks that ride under it.
    private func rowsUnder(_ id: String) -> [TaskListRow] {
        [TaskListRow(id: id, depth: 0)] + subtasks(of: id).map { TaskListRow(id: $0.id, depth: 1) }
    }

    /// Bumped when the device-local order changes, so the list redraws.
    static let orderRevisionKey = "list.orderRevision"

    /// The ids selection and the keyboard act on: the core's list.
    var listVisibleIds: [String] { result?.taskIds ?? [] }

    /// Today's progress: completed today against everything on Today.
    var todayProgress: (done: Int, total: Int)? {
        guard state.tab == .today, let result else { return nil }
        let done = result.doneIds.filter { items[$0]?.parentId == nil }.count
        let open = result.taskIds.filter { items[$0]?.parentId == nil }.count
        let total = done + open
        return total > 0 ? (done, total) : nil
    }

    /// The empty state to show, or `nil` when the list has rows.
    var listEmptyState: TaskListEmptyState? {
        guard let result, result.taskIds.isEmpty, result.doneIds.isEmpty else { return nil }
        if state.filters.isActive, result.totalCount > 0 { return .filtered }
        switch state.tab {
        case .today: return .today
        case .tomorrow: return .tomorrow
        case .next7: return .next7
        case .archived: return .archived
        case .all:
            if let project = project(state.projectId) { return .project(project.name) }
            return .all
        }
    }

    /// Desktop shows kanban on the All tab only; the windows and the archived
    /// scope stay list-only.
    var showsKanban: Bool {
        state.viewMode == .kanban && state.tab == .all
    }

    // MARK: Page state

    /// `handleTabChange`: leaving a tab drops a saved filter it was showing.
    func selectTab(_ tab: TasksTab) async {
        let clearsFilter = activeSavedFilterId != nil
        forgetSavedFilter()
        await update { state in
            state.tab = tab
            if clearsFilter { state.filters = TaskFilterSpec() }
        }
    }

    func selectProject(_ projectId: String?) async {
        await update { $0.projectId = projectId }
    }

    func applyStarredFilter(_ filter: SavedFilterItem) async {
        await applySavedFilter(filter)
    }

    func clearListFilters() async {
        await updateFilters { $0 = TaskFilterSpec() }
    }

    func setViewMode(_ mode: TasksViewMode) {
        state.viewMode = mode
    }

    /// Opens or closes a group; remembered with the view state.
    func toggleGroup(_ key: String) {
        if state.collapsedGroups.contains(key) {
            state.collapsedGroups.remove(key)
        } else {
            state.collapsedGroups.insert(key)
        }
    }

    // MARK: Drag writes

    /// A List move inside one section: the new order is kept device-locally
    /// and written as positions (no toast, as on desktop).
    func moveRows(
        in section: TaskListSection,
        from source: IndexSet,
        to destination: Int,
        selection: Set<String> = [],
        orders: TaskListOrders = TaskListOrders()
    ) async {
        let order = TaskReorder.topLevelOrder(
            rows: section.rows, moving: source, destination: destination, selection: selection
        )
        let current = section.rows.filter { $0.depth == 0 }.map(\.id)
        guard order != current else { return }
        orders.apply([section.id: order])
        // Redraw from the new order now, not after the write's refresh.
        scratch[Self.orderRevisionKey] = UUID().uuidString
        let positions = TaskReorder.positions(for: order)
        await perform(nil) { try $0.reorder(ids: order, positions: positions) }
    }

    /// `handleSectionDrop`: dropping tasks on a due-date group moves their
    /// date there and keeps each task's time.
    func reschedule(_ ids: [String], to bucket: TaskDueBucket) async {
        let tasks = ids.compactMap { items[$0] }
        guard !tasks.isEmpty else { return }
        var resolved: String?
        if let phrase = bucket.phrase {
            guard let parsed = parseTaskDate(input: phrase, now: localNow()) else {
                Log.core.error("a due bucket did not resolve to a date")
                return
            }
            resolved = parsed.date
        }
        let date = resolved
        let batches = Dictionary(grouping: tasks) { date == nil ? nil : $0.dueTime }
            .map { time, tasks in (time, tasks.map(\.id)) }
        let message = TasksCopy.rescheduled(count: tasks.count, target: bucket.label)
        await perform(message) { core in
            var merged: TaskChange?
            for (time, batch) in batches {
                merged = TasksStore.merge(merged, try core.bulkSetDue(ids: batch, date: date, time: time))
            }
            return TasksStore.merge(merged, nil)
        }
    }

    /// The ids a drag from this row carries: the selected set when the row is
    /// in it, else the row alone.
    func dragIds(for id: String, selection: Set<String>) -> [String] {
        guard selection.contains(id) else { return [id] }
        return listVisibleIds.filter(selection.contains)
    }
}
