import Foundation
import MemryCore

// TP047. The bulk bar's writes, after desktop's `hooks/use-bulk-actions.ts`.
// Each action is one core `bulk*` call, so one Undo reverts the whole
// selection (TP051). The toast counts the selection the way desktop does; the
// core decides what each write means (the done status, subtasks following a
// moved or deleted parent, the equivalent status in another project).
//
// Every action returns whether it wrote, so the bar clears the selection only
// after a write (desktop's `onComplete: deselectAll`).

/// A due-date preset from the bar's menu (`dueDateOptions`).
enum TaskBulkDuePreset: String, CaseIterable, Sendable {
    case today, tomorrow, nextWeek, nextMonth

    /// The phrase the core's date parser resolves: desktop's bulk presets
    /// are today, +1, +7 and +30 days (`pages/tasks.tsx`
    /// `handleBulkChangeDueDate`), which is not the quick-add "next week".
    var phrase: String {
        switch self {
        case .today: "today"
        case .tomorrow: "tomorrow"
        case .nextWeek: "in 7 days"
        case .nextMonth: "in 30 days"
        }
    }

    var title: String {
        switch self {
        case .today: TasksCopy.dueToday
        case .tomorrow: TasksCopy.dueTomorrow
        case .nextWeek: TasksCopy.dueNextWeek
        case .nextMonth: TasksCopy.dueNextMonth
        }
    }
}

extension TasksStore {
    // MARK: Reading the selection

    /// The selected tasks this vault still holds, in `position` order. An id
    /// that vanished meanwhile (deleted on another device) drops out.
    func selectedTasks(_ selection: Set<String>) -> [TaskItem] {
        ordered.filter { selection.contains($0.id) }
    }

    /// The page shows archived tasks, so the bar offers Unarchive instead of
    /// Archive (`isArchivedScope`).
    var isArchivedScope: Bool {
        state.tab == .archived || state.filters.completion == "archived"
    }

    /// The projects a selection can move to: every live one, Inbox included.
    var bulkMoveTargets: [ProjectItem] {
        projects.filter { $0.archivedAt == nil }
    }

    /// The statuses the selection can take: those of the one project every
    /// selected task shares. A mixed selection gets none, since a status
    /// belongs to one project.
    func bulkStatuses(_ selection: Set<String>) -> [StatusItem] {
        let projectIds = Set(selectedTasks(selection).map(\.projectId))
        guard projectIds.count == 1, let only = projectIds.first else { return [] }
        return project(only)?.statuses ?? []
    }

    // MARK: Writing

    /// Completes the open tasks in the selection; says so and writes nothing
    /// when every one is already done.
    func completeSelection(_ selection: Set<String>) async -> Bool {
        let open = selectedTasks(selection).filter { !$0.isDone }.map(\.id)
        guard !open.isEmpty else {
            undoable = nil
            toast = TasksCopy.alreadyAllComplete
            return false
        }
        return await bulk(TasksCopy.bulkCompleted(open.count)) { try $0.bulkComplete(ids: open) }
    }

    /// Reopens the completed tasks in the selection (`bulkUncomplete`).
    func uncompleteSelection(_ selection: Set<String>) async -> Bool {
        let done = selectedTasks(selection).filter(\.isDone).map(\.id)
        guard !done.isEmpty else {
            undoable = nil
            toast = TasksCopy.noCompletedSelected
            return false
        }
        return await bulk(TasksCopy.bulkRestored(done.count)) { try $0.bulkUncomplete(ids: done) }
    }

    /// Sets (0 removes) the priority of every selected task.
    func setPriority(of selection: Set<String>, to priority: Int64) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        let message = TasksCopy.bulkPrioritySet(ids.count, priority: priority)
        return await bulk(message) { try $0.bulkSetPriority(ids: ids, priority: priority) }
    }

    /// Sets or (with `nil`) removes the due date and time of every selected
    /// task.
    func setDue(of selection: Set<String>, date: String?, time: String?) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        let message = date == nil ? TasksCopy.bulkDueDateRemoved(ids.count) : TasksCopy.bulkDueDateSet(ids.count)
        return await bulk(message) { try $0.bulkSetDue(ids: ids, date: date, time: date == nil ? nil : time) }
    }

    /// A preset day, resolved by the core's date parser against the local
    /// clock. Each task keeps its own time, as desktop's preset does: the core
    /// writes date and time together, so tasks sharing a time go in one call,
    /// and the calls are one undo.
    func setDue(of selection: Set<String>, preset: TaskBulkDuePreset) async -> Bool {
        guard let parsed = parseTaskDate(input: preset.phrase, now: localNow()) else {
            Log.core.error("a bulk due-date preset did not parse")
            return false
        }
        let tasks = selectedTasks(selection)
        guard !tasks.isEmpty else { return false }
        let date = parsed.date
        let batches = Dictionary(grouping: tasks, by: \.dueTime).map { time, tasks in (time, tasks.map(\.id)) }
        return await bulk(TasksCopy.bulkDueDateSet(tasks.count)) { core in
            var merged: TaskChange?
            for (time, ids) in batches {
                merged = TasksStore.merge(merged, try core.bulkSetDue(ids: ids, date: date, time: time))
            }
            return TasksStore.merge(merged, nil)
        }
    }

    /// Moves every selected task to `project`.
    func move(_ selection: Set<String>, to project: ProjectItem) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        let target = project.id
        return await bulk(TasksCopy.bulkMoved(ids.count, project: project.name)) {
            try $0.bulkMove(ids: ids, projectId: target)
        }
    }

    /// Gives every selected task `status`.
    func setStatus(of selection: Set<String>, to status: StatusItem) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        let statusId = status.id
        return await bulk(TasksCopy.bulkMovedToStatus(ids.count, status: status.name)) {
            try $0.bulkSetStatus(ids: ids, statusId: statusId)
        }
    }

    func archiveSelection(_ selection: Set<String>) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        return await bulk(TasksCopy.bulkArchived(ids.count)) { try $0.bulkArchive(ids: ids) }
    }

    func unarchiveSelection(_ selection: Set<String>) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        return await bulk(TasksCopy.bulkUnarchived(ids.count)) { try $0.bulkUnarchive(ids: ids) }
    }

    /// Deletes every selected task and its subtasks. The bar asks first.
    func deleteSelection(_ selection: Set<String>) async -> Bool {
        let ids = selectedTasks(selection).map(\.id)
        guard !ids.isEmpty else { return false }
        return await bulk(TasksCopy.bulkDeleted(ids.count)) { try $0.bulkDelete(ids: ids) }
    }

    private func bulk(
        _ message: String,
        _ work: @escaping @Sendable (any TasksProtocol) throws -> TaskChange
    ) async -> Bool {
        await perform(message, work) != nil
    }
}
