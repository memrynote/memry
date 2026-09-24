import MemryCore
import SwiftUI

// TP041. What one task row reads and writes: the Move menu's reschedule / move
// to project / change status (desktop `drag-drop/move-menu.tsx`), duplicate,
// archive, and the facts the row draws (its status, subtask progress, linked
// note mark, VoiceOver summary).
//
// **Dates come from the core's parser.** The reschedule targets are phrases
// `parseTaskDate` resolves against the local clock, so "today" on the phone is
// the same day desktop and the vectors call today. Completing and deleting are
// not here: every checkbox and delete goes through `requestComplete` /
// `requestDelete` (TasksStore+Subtasks), which own the prompts.
//
// Methods carry a `row` prefix so the blocks that extend the store in their own
// files (bulk, detail, kanban) never declare the same name.

/// A Move menu reschedule target (`move-menu.tsx`).
enum TaskRescheduleOption: String, CaseIterable, Identifiable, Sendable {
    case today, tomorrow, nextWeek, removeDate

    var id: String { rawValue }

    /// The phrase the core's date parser resolves; `nil` clears the date.
    /// Desktop's "Next week" is today + 7 days (`addDays(today, 7)`), which is
    /// the parser's "in 7 days", not its "next week" (next Monday).
    var phrase: String? {
        switch self {
        case .today: "today"
        case .tomorrow: "tomorrow"
        case .nextWeek: "in 7 days"
        case .removeDate: nil
        }
    }

    var title: String {
        switch self {
        case .today: TasksCopy.rowToday
        case .tomorrow: TasksCopy.rowTomorrow
        case .nextWeek: TasksCopy.rowNextWeek
        case .removeDate: TasksCopy.rowRemoveDate
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .tomorrow: "sunrise"
        case .nextWeek: "calendar.badge.clock"
        case .removeDate: "calendar.badge.minus"
        }
    }
}

extension TasksStore {
    // MARK: Reading

    /// The `YYYY-MM-DD` a reschedule option lands on, from the core's parser;
    /// `nil` for "Remove date" or a phrase the parser does not read.
    func rowRescheduleDate(_ option: TaskRescheduleOption) -> String? {
        guard let phrase = option.phrase else { return nil }
        return parseTaskDate(input: phrase, now: localNow())?.date
    }

    /// The task's status in its project, if the project still holds it.
    func rowStatus(_ task: TaskItem) -> StatusItem? {
        guard let statusId = task.statusId else { return nil }
        return project(task.projectId)?.statuses.first { $0.id == statusId }
    }

    /// The statuses "Change status" offers: the task's project's.
    func rowStatuses(_ task: TaskItem) -> [StatusItem] {
        project(task.projectId)?.statuses ?? []
    }

    /// The projects "Move to project" offers: every live one
    /// (`projects.filter((p) => !p.isArchived)`).
    func rowMoveTargets() -> [ProjectItem] {
        projects.filter { $0.archivedAt == nil }
    }

    /// Done and total live subtasks.
    func rowSubtaskCounts(_ task: TaskItem) -> (done: Int, total: Int) {
        let subtasks = subtasks(of: task.id)
        return (subtasks.filter(\.isDone).count, subtasks.count)
    }

    /// Notes the task points at: its linked notes, else the note it came from
    /// (`getRelatedNoteIds`, `task-linked-note-indicator.tsx`).
    func rowLinkedNoteCount(_ task: TaskItem) -> Int {
        if !task.linkedNoteIds.isEmpty { return task.linkedNoteIds.count }
        return task.sourceNoteId == nil ? 0 : 1
    }

    /// Whether "Make subtask of..." applies: the core refuses to nest a task
    /// that has subtasks of its own.
    func rowCanBecomeSubtask(_ task: TaskItem) -> Bool {
        subtasks(of: task.id).isEmpty
    }

    /// The row's one VoiceOver sentence.
    func rowAccessibilityLabel(_ task: TaskItem) -> String {
        var parts = [task.title]
        if task.isDone { parts.append(TasksCopy.rowCompletedSuffix) }
        if task.priority > 0 { parts.append(TasksCopy.rowPriority(task.priority)) }
        if !task.isDone, let due = dueLabel(task) { parts.append(TasksCopy.rowDue(due)) }
        let counts = rowSubtaskCounts(task)
        if counts.total > 0 { parts.append(TasksCopy.rowSubtasks(done: counts.done, total: counts.total)) }
        if task.repeat != nil { parts.append(TasksCopy.rowRepeats) }
        let notes = rowLinkedNoteCount(task)
        if notes > 0 { parts.append(TasksCopy.rowLinkedNotes(notes)) }
        if let project = project(task.projectId) { parts.append(TasksCopy.rowProject(project.name)) }
        if !task.tags.isEmpty { parts.append(TasksCopy.rowTags(task.tags)) }
        return parts.joined(separator: ", ")
    }

    // MARK: Writing

    /// Moves the due date to a Move menu target, keeping the time of day;
    /// "Remove date" clears both.
    func rowReschedule(_ task: TaskItem, to option: TaskRescheduleOption) async {
        let id = task.id
        guard option.phrase != nil else {
            await perform(TasksCopy.rowDueDateRemoved) { try $0.setDue(id: id, date: nil, time: nil) }
            return
        }
        guard let date = rowRescheduleDate(option) else {
            Log.interface.error("a reschedule phrase did not resolve")
            return
        }
        let time = task.dueTime
        await perform(TasksCopy.rowRescheduledTo(option.title)) {
            try $0.setDue(id: id, date: date, time: time)
        }
    }

    /// Moves the task (and its subtasks) to another project.
    func rowMove(_ task: TaskItem, to project: ProjectItem) async {
        guard project.id != task.projectId else { return }
        let id = task.id
        let projectId = project.id
        await perform(TasksCopy.rowMovedTo(project.name)) { try $0.setProject(id: id, projectId: projectId) }
    }

    /// Sets one of the task's project's statuses.
    func rowSetStatus(_ task: TaskItem, to status: StatusItem) async {
        guard status.id != task.statusId else { return }
        let id = task.id
        let statusId = status.id
        await perform(TasksCopy.rowMovedTo(status.name)) { try $0.setStatus(id: id, statusId: statusId) }
    }

    func rowDuplicate(_ task: TaskItem, withSubtasks: Bool) async {
        let id = task.id
        await perform(TasksCopy.created) { try $0.duplicate(id: id, withSubtasks: withSubtasks) }
    }

    /// Archives a live task, or restores an archived one.
    func rowToggleArchive(_ task: TaskItem) async {
        let ids = [task.id]
        if task.archivedAt == nil {
            await perform(TasksCopy.archived) { try $0.bulkArchive(ids: ids) }
        } else {
            await perform(TasksCopy.rowRestored) { try $0.bulkUnarchive(ids: ids) }
        }
    }
}
