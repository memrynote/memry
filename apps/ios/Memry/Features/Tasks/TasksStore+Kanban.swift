import Foundation
import MemryCore

// TP049. The kanban board over the store: which columns a mode has, which
// column a task sits in, and what a drop or a column's "+" writes.
//
// Desktop reference: `components/tasks/kanban/kanban-columns.ts`
// (`buildColumnConfig`), `lib/kanban-drop-resolver.ts` (`resolveColumnDrop`,
// `dueBucketToDate`), `hooks/use-drag-handlers.ts` (the column-drop writes)
// and `pages/tasks.tsx` (`kanbanTasks`, `handleKanbanQuickAdd`).
//
// Every rule stays in the core (D5): the cards are the core view's rows plus
// its Done section; due buckets are the core's due-date groups; a bucket's
// date comes from `parseTaskDate`; moving to a project resolves the status
// there in the core. Swift only reads fields and picks a column.

extension TasksStore {
    /// The column mode the page state holds.
    var kanbanMode: KanbanColumnMode {
        KanbanColumnMode(stored: state.kanbanColumns)
    }

    /// Picks the column mode (persisted with the page state).
    func setKanbanMode(_ mode: KanbanColumnMode) {
        state.kanbanColumns = mode.rawValue
    }

    /// The mode the board actually draws: `status` without one selected
    /// project falls back to canonical, as on desktop.
    var kanbanEffectiveMode: KanbanColumnMode {
        switch kanbanMode {
        case .status: project(state.projectId) == nil ? .canonical : .status
        case let other: other
        }
    }

    // MARK: Columns

    /// The columns of the current mode (`buildColumnConfig`).
    func kanbanColumns() -> [KanbanColumn] {
        switch kanbanEffectiveMode {
        case .canonical:
            return ["todo", "in_progress", "done"].map {
                KanbanColumn(id: $0, title: TasksCopy.statusTypeLabel($0), target: .statusType($0))
            }
        case .status:
            guard let project = project(state.projectId) else { return [] }
            return project.statuses.sorted { $0.position < $1.position }.map { status in
                KanbanColumn(
                    id: status.id,
                    title: status.name,
                    target: .status(id: status.id, name: status.name, type: status.statusType, projectId: project.id),
                    color: status.color
                )
            }
        case .priority:
            return [Int64(4), 3, 2, 1, 0].map { value in
                KanbanColumn(
                    id: "priority-\(Self.kanbanPriorityKey(value))",
                    title: TasksCopy.priorityLabel(value),
                    target: .priority(value)
                )
            }
        case .dueDate:
            return Self.kanbanDueBuckets.map { bucket in
                KanbanColumn(
                    id: "due-\(bucket)",
                    title: TasksCopy.groupLabel("dueDate.\(bucket)"),
                    target: .due(bucket)
                )
            }
        case .project:
            return projects.filter { $0.archivedAt == nil }.map { project in
                KanbanColumn(
                    id: "project-\(project.id)",
                    title: project.name,
                    target: .project(id: project.id, name: project.name),
                    color: project.color
                )
            }
        }
    }

    /// The core's due-date group keys, in column order.
    static let kanbanDueBuckets = ["overdue", "today", "tomorrow", "upcoming", "later", "noDueDate"]

    static func kanbanPriorityKey(_ value: Int64) -> String {
        switch value {
        case 4: "urgent"
        case 3: "high"
        case 2: "medium"
        case 1: "low"
        default: "none"
        }
    }

    // MARK: Cards

    /// The board's cards: the page's rows, then its Done section, so the done
    /// column holds completed tasks (desktop's `kanbanTasks`).
    func kanbanTasks() -> [TaskItem] {
        guard let result else { return [] }
        var seen = Set<String>()
        return (result.taskIds + result.doneIds).compactMap { id in
            guard seen.insert(id).inserted, let task = items[id], task.archivedAt == nil else { return nil }
            return task
        }
    }

    /// The board: every column with its cards, in the page's order.
    ///
    /// - Parameter dueBuckets: task id to the core's due group key, from
    ///   ``kanbanLoadDueBuckets()``; only the due-date mode reads it.
    func kanbanLanes(dueBuckets: [String: String] = [:]) -> [KanbanLane] {
        let columns = kanbanColumns()
        var cards: [String: [TaskItem]] = [:]
        for task in kanbanTasks() {
            guard let columnId = kanbanColumnId(for: task, dueBuckets: dueBuckets) else { continue }
            cards[columnId, default: []].append(task)
        }
        return columns.map { KanbanLane(column: $0, tasks: cards[$0.id] ?? []) }
    }

    /// The column a task sits in under the current mode, or `nil` when it has
    /// none (another project's task on a project's status board, a task in
    /// an archived project).
    func kanbanColumnId(for task: TaskItem, dueBuckets: [String: String] = [:]) -> String? {
        switch kanbanEffectiveMode {
        case .canonical:
            return task.statusType ?? "todo"
        case .status:
            guard task.projectId == state.projectId,
                  let statusId = task.statusId,
                  project(task.projectId)?.statuses.contains(where: { $0.id == statusId }) == true
            else { return nil }
            return statusId
        case .priority:
            return "priority-\(Self.kanbanPriorityKey(task.priority))"
        case .dueDate:
            return "due-\(dueBuckets[task.id] ?? kanbanFallbackBucket(task))"
        case .project:
            guard project(task.projectId)?.archivedAt == nil, project(task.projectId) != nil else { return nil }
            return "project-\(task.projectId)"
        }
    }

    /// The core's due groups for the page, keyed by task id: the page query
    /// with a due-date sort, so the buckets are the core's (`groupByDueDate`).
    func kanbanLoadDueBuckets() async -> [String: String] {
        let query = TaskViewQuery(
            tab: state.tab.rawValue,
            projectId: state.projectId,
            filtersJson: state.filters.json,
            sortJson: TaskSortSpec(field: "dueDate", direction: "asc").json,
            now: localNow(),
            weekStartsOn: weekStartsOn
        )
        guard let answer = await read({ try $0.view(query: query) }) else { return [:] }
        var buckets: [String: String] = [:]
        for group in answer.groups {
            for id in group.taskIds { buckets[id] = group.key }
        }
        return buckets
    }

    /// A card the core's groups do not cover (a subtask, a completed task):
    /// the relative day its due badge shows.
    private func kanbanFallbackBucket(_ task: TaskItem) -> String {
        guard let due = task.dueDate,
              let label = TaskDueLabel.make(date: due, time: nil, today: today(), isDone: false)
        else { return "noDueDate" }
        switch label.tone {
        case .overdue: return "overdue"
        case .today: return "today"
        case .tomorrow: return "tomorrow"
        case .upcoming: return "upcoming"
        case .later, .done: return "later"
        }
    }

    /// The date a due column stands for (`dueBucketToDate`), read by the
    /// core's date parser; `nil` clears the date.
    func kanbanDueDate(_ bucket: String) -> String? {
        let phrase: String? = switch bucket {
        case "today": "today"
        case "tomorrow": "tomorrow"
        case "upcoming": "in 3 days"
        case "later": "in 14 days"
        default: nil
        }
        guard let phrase else { return nil }
        return parseTaskDate(input: phrase, now: localNow())?.date
    }
}

// MARK: - Writes

extension TasksStore {
    /// Drops a task on a column (`resolveColumnDrop` then the drag handler's
    /// write). A drop on the task's own column, or one that cannot resolve
    /// (no status of that type in the task's project), writes nothing.
    ///
    /// - Returns: whether a write was made.
    @discardableResult
    func kanbanMove(taskId: String, to column: KanbanColumn, dueBuckets: [String: String] = [:]) async -> Bool {
        guard let task = items[taskId],
              kanbanColumnId(for: task, dueBuckets: dueBuckets) != column.id
        else { return false }
        let id = task.id
        switch column.target {
        case let .priority(value):
            let message = TasksCopy.kanbanPrioritySet(TasksCopy.priorityLabel(value))
            return await perform(message) { try $0.setPriority(id: id, priority: value) } != nil
        case let .due(bucket):
            let date = kanbanDueDate(bucket)
            let time = date == nil ? nil : task.dueTime
            let target = date == nil ? TasksCopy.groupLabel("dueDate.noDueDate") : column.title
            let message = TasksCopy.kanbanRescheduled(target)
            return await perform(message) { try $0.setDue(id: id, date: date, time: time) } != nil
        case let .project(projectId, name):
            guard projectId != task.projectId else { return false }
            return await perform(TasksCopy.kanbanMoved(name)) { try $0.setProject(id: id, projectId: projectId) } != nil
        case let .statusType(type):
            guard let status = kanbanStatus(ofType: type, in: task.projectId), status.id != task.statusId else {
                return false
            }
            let statusId = status.id
            let message = TasksCopy.kanbanMoved(TasksCopy.statusTypeLabel(type))
            return await perform(message) { try $0.setStatus(id: id, statusId: statusId) } != nil
        case let .status(statusId, name, _, projectId):
            guard task.projectId == projectId, task.statusId != statusId else { return false }
            return await perform(TasksCopy.kanbanMoved(name)) { try $0.setStatus(id: id, statusId: statusId) } != nil
        }
    }

    /// A column's "+": a task with the column's value preset, so it lands in
    /// that column (desktop presets the status; the other modes preset their
    /// own field the same way).
    ///
    /// - Returns: whether the task was created.
    @discardableResult
    func kanbanAdd(title: String, to column: KanbanColumn) async -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, column.acceptsAdd, var projectId = kanbanAddProjectId() else { return false }
        var statusId: String?
        var priority: Int64 = 0
        var dueDate: String?
        switch column.target {
        case let .project(id, _):
            projectId = id
        case let .status(id, _, _, owner):
            projectId = owner
            statusId = id
        case let .statusType(type):
            statusId = type == "todo" ? nil : kanbanStatus(ofType: type, in: projectId)?.id
        case let .priority(value):
            priority = value
        case let .due(bucket):
            dueDate = kanbanDueDate(bucket)
        }
        let input = NewTaskInput(
            title: title,
            projectId: projectId,
            statusId: statusId,
            parentId: nil,
            priority: priority,
            description: nil,
            dueDate: dueDate,
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
        return await perform(TasksCopy.created) { try $0.create(input: input) } != nil
    }

    /// The project a new card goes to outside the project modes: the page's
    /// project, else the default project, else the Inbox, else the first
    /// live project (desktop: `selectedProject || projects[0]`).
    func kanbanAddProjectId() -> String? {
        let live = projects.filter { $0.archivedAt == nil }
        if let scoped = project(state.projectId), scoped.archivedAt == nil { return scoped.id }
        if let preferred = project(settings?.defaultProjectId), preferred.archivedAt == nil { return preferred.id }
        return (live.first { $0.isInbox } ?? live.first)?.id
    }

    /// A project's first status of a type, in position order.
    func kanbanStatus(ofType type: String, in projectId: String) -> StatusItem? {
        project(projectId)?.statuses
            .sorted { $0.position < $1.position }
            .first { $0.statusType == type }
    }
}
