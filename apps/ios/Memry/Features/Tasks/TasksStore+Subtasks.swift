import Foundation
import MemryCore

// TP046. Every subtask write, after desktop's `hooks/use-subtask-management.ts`
// and `lib/subtask-bulk-utils.ts`. The rules (which status "done" is, what a
// cascade touches, who may be a parent) are the core's; this file decides only
// when to ask first and what the toast says.
//
// **Asking first** (`requestComplete` / `requestDelete`, the entry points every
// checkbox and delete action uses): completing a top-level task with open
// subtasks raises `.completeParent`; completing the last open subtask raises
// `.allSubtasksDone`; deleting a task with subtasks raises `.deleteParent`.
// `subtaskPrompts(store:)` hosts the dialogs that answer them.
//
// **Duplicate and the parent picker** are raised the same way through
// `scratch`, so any screen (row menu, detail) can ask without owning the
// dialog: `requestDuplicate(_:)`, `requestParentPicker(_:)`.

extension TasksStore {
    /// `scratch` keys for the dialogs this block hosts.
    static let duplicateScratchKey = "subtasks.duplicate"
    static let parentPickerScratchKey = "subtasks.parentPicker"

    // MARK: Entry points

    /// The one entry point every checkbox uses to complete or reopen a task.
    func requestComplete(_ task: TaskItem) async {
        let id = task.id
        if task.isDone {
            await perform(TasksCopy.updated) { try $0.uncomplete(id: id) }
            return
        }
        if task.parentId == nil, !openSubtasks(of: id).isEmpty {
            prompt = .completeParent(taskId: id)
            return
        }
        await completeTask(id, keepSubtasksOpen: false)
        if let parentId = task.parentId { offerParentCompletion(parentId) }
    }

    /// The one entry point every delete action uses.
    func requestDelete(_ task: TaskItem) async {
        let id = task.id
        if task.parentId == nil, !subtasks(of: id).isEmpty {
            prompt = .deleteParent(taskId: id)
            return
        }
        let message = task.parentId == nil ? TasksCopy.deleted : TasksCopy.subtaskDeleted
        await perform(message) { try $0.delete(id: id, promoteSubtasks: false) }
    }

    /// Duplicates at once, or asks whether the subtasks come too.
    func requestDuplicate(_ task: TaskItem) async {
        if subtasks(of: task.id).isEmpty {
            await duplicate(task.id, withSubtasks: false)
        } else {
            scratch[Self.duplicateScratchKey] = task.id
        }
    }

    /// Opens the "Make subtask of…" picker for a task.
    func requestParentPicker(_ task: TaskItem) {
        scratch[Self.parentPickerScratchKey] = task.id
    }

    // MARK: Prompt answers

    /// `confirmCompleteParent`: all completes the open subtasks with the parent
    /// (the core's cascade); parent only leaves them open.
    func completeParent(_ id: String, withSubtasks: Bool) async {
        prompt = nil
        await completeTask(id, keepSubtasksOpen: !withSubtasks)
    }

    /// `autoCompleteParent` from the all-subtasks-done dialog.
    func completeParentAfterSubtasks(_ parentId: String) async {
        prompt = nil
        await completeTask(parentId, keepSubtasksOpen: false)
    }

    /// `keepParentOpen`.
    func keepParentOpen() {
        prompt = nil
        toast = TasksCopy.subtaskParentKeptOpen
    }

    /// `confirmDeleteParent`: the subtasks go with it, or become tasks.
    func deleteParent(_ id: String, keepSubtasks: Bool) async {
        prompt = nil
        let message = keepSubtasks
            ? TasksCopy.subtaskParentDeletedKeepSubtasks
            : TasksCopy.subtaskParentDeletedWithSubtasks
        await perform(message) { try $0.delete(id: id, promoteSubtasks: keepSubtasks) }
    }

    func duplicate(_ id: String, withSubtasks: Bool) async {
        scratch[Self.duplicateScratchKey] = nil
        await perform(TasksCopy.created) { try $0.duplicate(id: id, withSubtasks: withSubtasks) }
    }

    // MARK: Structure

    /// Inline add: a subtask in the parent's project and, while the parent is
    /// open, its status (`createSubtask`).
    @discardableResult
    func addSubtask(to parent: TaskItem, title: String) async -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let input = NewTaskInput(
            title: trimmed,
            projectId: parent.projectId,
            statusId: parent.isDone ? nil : parent.statusId,
            parentId: parent.id,
            priority: 0,
            description: nil,
            dueDate: nil,
            dueTime: nil,
            startDate: nil,
            repeat: nil,
            repeatFrom: nil,
            tags: [],
            linkedNoteIds: [],
            linkedCanvasIds: [],
            sourceNoteId: nil,
            position: nil
        )
        return await perform(TasksCopy.subtaskAdded) { try $0.create(input: input) } != nil
    }

    /// Writes the subtasks' new order as positions 0, 1, 2… (`reorderSubtasks`).
    func reorderSubtasks(_ ids: [String]) async {
        let positions = ids.indices.map { Int64($0) }
        await perform(nil) { try $0.reorder(ids: ids, positions: positions) }
    }

    /// Moves one subtask of `parentId` by `offset` places (drag or Move up/down).
    func moveSubtask(_ id: String, of parentId: String, by offset: Int) async {
        var ids = subtasks(of: parentId).map(\.id)
        guard let from = ids.firstIndex(of: id) else { return }
        let to = min(max(from + offset, 0), ids.count - 1)
        guard to != from else { return }
        ids.insert(ids.remove(at: from), at: to)
        await reorderSubtasks(ids)
    }

    /// `promoteToTask`.
    func promoteToTask(_ subtask: TaskItem) async {
        let id = subtask.id
        await perform(TasksCopy.subtaskPromoted(subtask.title)) { try $0.setParent(id: id, parentId: nil) }
    }

    /// `confirmDemoteToSubtask`. The core keeps a subtask in its parent's
    /// project, so a parent from another project first moves the task there;
    /// both writes undo together.
    func makeSubtask(_ task: TaskItem, of parent: TaskItem) async {
        scratch[Self.parentPickerScratchKey] = nil
        let id = task.id
        let parentId = parent.id
        let targetProject = task.projectId == parent.projectId ? nil : parent.projectId
        await perform(TasksCopy.subtaskMovedUnder(parent.title)) { core in
            guard let targetProject else { return try core.setParent(id: id, parentId: parentId) }
            let moved = try core.setProject(id: id, projectId: targetProject)
            do {
                let parented = try core.setParent(id: id, parentId: parentId)
                return TasksStore.merge(moved, parented)
            } catch {
                _ = try? core.undo(change: moved)
                throw error
            }
        }
    }

    // MARK: Bulk (`subtask-bulk-utils.ts`)

    func completeAllSubtasks(of parentId: String) async {
        let change = await performCounted(TasksCopy.subtasksCompleted) {
            try $0.completeAllSubtasks(parentId: parentId)
        }
        if change != nil { offerParentCompletion(parentId) }
    }

    func markAllSubtasksIncomplete(of parentId: String) async {
        await performCounted(TasksCopy.subtasksMarkedIncomplete) {
            try $0.incompleteAllSubtasks(parentId: parentId)
        }
    }

    func setDueForAllSubtasks(of parentId: String, date: String?, includeCompleted: Bool) async {
        let message = date == nil ? TasksCopy.subtasksDueCleared : TasksCopy.subtasksDueSet
        await performCounted(message) {
            try $0.setDueForAllSubtasks(parentId: parentId, date: date, includeCompleted: includeCompleted)
        }
    }

    func setPriorityForAllSubtasks(of parentId: String, priority: Int64, includeCompleted: Bool) async {
        await performCounted(TasksCopy.subtasksPrioritySet) {
            try $0.setPriorityForAllSubtasks(parentId: parentId, priority: priority, includeCompleted: includeCompleted)
        }
    }

    func deleteAllSubtasks(of parentId: String) async {
        let work: @Sendable (any TasksProtocol) throws -> TaskChange = { try $0.deleteAllSubtasks(parentId: parentId) }
        await performCounted(TasksCopy.subtasksDeleted, counting: \.deleted, work)
    }

    // MARK: Reading

    /// The subtasks of `parentId` still open.
    func openSubtasks(of parentId: String) -> [TaskItem] {
        subtasks(of: parentId).filter { !$0.isDone }
    }

    /// The top-level tasks a task may move under, same project first, then
    /// newest (`getPotentialParents`); `query` narrows by title.
    func parentCandidates(for task: TaskItem, matching query: String = "") -> [TaskItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return ordered
            .filter { candidate in
                candidate.id != task.id && candidate.id != task.parentId
                    && candidate.parentId == nil && candidate.archivedAt == nil
                    && (needle.isEmpty || candidate.title.localizedCaseInsensitiveContains(needle))
            }
            .sorted { lhs, rhs in
                let lhsSame = lhs.projectId == task.projectId
                let rhsSame = rhs.projectId == task.projectId
                if lhsSame != rhsSame { return lhsSame }
                return (lhs.createdAt ?? "") > (rhs.createdAt ?? "")
            }
    }

    // MARK: Helpers

    /// Completes a task. With `keepSubtasksOpen`, the subtasks the core's
    /// cascade closed are restored from its own record of them, in the same
    /// executor call, so the Undo toast still reverts everything at once.
    private func completeTask(_ id: String, keepSubtasksOpen: Bool) async {
        let now = localNow()
        let open = Set(openSubtasks(of: id).map(\.id))
        let restoring = keepSubtasksOpen ? open : []
        let completion: TaskCompletion? = await run { core in
            let completion = try core.complete(id: id, localNow: now)
            let reopened = completion.change.changed.filter { restoring.contains($0.taskId) }
            if !reopened.isEmpty {
                _ = try core.undo(change: TaskChange(changed: reopened, created: [], deleted: [], removed: []))
            }
            return completion
        }
        guard let completion else { return }
        let message = completionMessage(completion, cascaded: !open.isEmpty && !keepSubtasksOpen)
        undoable = TasksUndo(message: message, change: completion.change)
        toast = message
    }

    private func completionMessage(_ completion: TaskCompletion, cascaded: Bool) -> String {
        if completion.repeating {
            guard let next = completion.nextDueDate else { return TasksCopy.seriesComplete }
            let pretty = TaskDates.date(next)?.formatted(.dateTime.month(.abbreviated).day()) ?? next
            return TasksCopy.nextOccurrence(pretty)
        }
        return cascaded ? TasksCopy.subtaskParentAndSubtasksCompleted : TasksCopy.completed
    }

    /// Raises `.allSubtasksDone` when the parent is open and every one of its
    /// subtasks is done (`checkAllSubtasksComplete`).
    private func offerParentCompletion(_ parentId: String) {
        guard let parent = items[parentId], !parent.isDone else { return }
        let all = subtasks(of: parentId)
        if !all.isEmpty, all.allSatisfy(\.isDone) {
            prompt = .allSubtasksDone(parentId: parentId)
        }
    }

    /// A bulk write whose toast counts the tasks it touched.
    @discardableResult
    private func performCounted(
        _ message: @escaping (Int) -> String,
        counting: KeyPath<TaskChange, [String]>? = nil,
        _ work: @escaping @Sendable (any TasksProtocol) throws -> TaskChange
    ) async -> TaskChange? {
        guard let change = await perform(nil, work) else { return nil }
        let count = counting.map { change[keyPath: $0].count } ?? Set(change.changed.map(\.taskId)).count
        let text = message(count)
        undoable = TasksUndo(message: text, change: change)
        toast = text
        return change
    }
}
