import Foundation
import MemryCore

// Spec 007 CL014. `buildTimelineGroups` / `buildEventRows` of
// `timeline-model.ts`.

extension TimelineModel {
    /// `STATUS_ORDER`, `PRIORITY_ORDER` (urgent 4 .. none 0).
    static let statusOrder = ["todo", "in_progress", "done"]
    static let priorityOrder: [Int64] = [4, 3, 2, 1, 0]

    static func statusType(_ task: TaskItem, project: ProjectItem) -> String {
        if let status = project.statuses.first(where: { $0.id == task.statusId }) { return status.statusType }
        return task.completedAt != nil ? "done" : "todo"
    }

    /// `toTaskRow`.
    static func row(_ task: TaskItem, project: ProjectItem, window: Window, today: String) -> TaskRow? {
        let shape = shape(start: task.startDate, due: task.dueDate)
        let completed = task.completedAt != nil
        let bounds = bounds(shape)
        let lastDay: String? = switch shape {
        case let .span(_, end): end
        case let .due(date): date
        default: nil
        }
        let overdue = !completed && lastDay.map { $0 < today } == true
        let placement = bounds.flatMap { place(first: $0.first, last: $0.last, window: window) }
        let todayInWindow = today >= window.start && today <= window.end
        if bounds != nil, placement == nil, !(overdue && todayInWindow) { return nil }
        return TaskRow(
            task: task, depth: 0, shape: shape, placement: placement, isOverdue: overdue,
            isCompleted: completed, statusType: completed ? "done" : statusType(task, project: project),
            projectName: project.name, color: project.color
        )
    }

    static func sortKey(_ row: TaskRow, _ order: TimelineOrderBy) -> String? {
        switch row.shape {
        case .none: nil
        case let .span(start, end): order == .due ? end : start
        case let .due(date), let .start(date): date
        }
    }

    /// `compareRows`.
    static func precedes(_ a: TaskRow, _ b: TaskRow, _ order: TimelineOrderBy) -> Bool {
        let byTitle = a.task.title.localizedStandardCompare(b.task.title)
        if order == .title { return byTitle == .orderedAscending }
        let ka = sortKey(a, order), kb = sortKey(b, order)
        guard let ka, let kb else {
            if (ka == nil) != (kb == nil) { return kb == nil }
            return byTitle == .orderedAscending
        }
        if ka != kb { return ka < kb }
        let ea = bounds(a.shape)?.last ?? "", eb = bounds(b.shape)?.last ?? ""
        if ea != eb { return ea < eb }
        return byTitle == .orderedAscending
    }

    /// `nestRows`: order, then tuck each visible subtask under its parent.
    static func nest(_ rows: [TaskRow], _ order: TimelineOrderBy) -> [TaskRow] {
        let ids = Set(rows.map(\.task.id))
        var children: [String: [TaskRow]] = [:]
        var roots: [TaskRow] = []
        for row in rows {
            if let parent = row.task.parentId, ids.contains(parent) {
                var child = row
                child.depth = 1
                children[parent, default: []].append(child)
            } else {
                roots.append(row)
            }
        }
        roots.sort { precedes($0, $1, order) }
        return roots.flatMap { root in
            [root] + (children[root.task.id] ?? []).sorted { precedes($0, $1, order) }
        }
    }

    /// `summarize`: the extent of every scheduled row, when over a day.
    static func summary(_ rows: [Row]) -> Placement? {
        let placed: [Placement] = rows.compactMap { row in
            if case let .task(task) = row, case .none = task.shape { return nil }
            return row.placement
        }
        guard let from = placed.map(\.from).min(), let to = placed.map(\.to).max(), to > from else { return nil }
        return Placement(
            from: from, to: to,
            clippedStart: placed.contains(where: \.clippedStart),
            clippedEnd: placed.contains(where: \.clippedEnd)
        )
    }

    /// `buildEventRows`: all-day and multi-day events.
    static func eventRows(_ items: [CalendarItem], window: Window) -> [EventRow] {
        items
            .filter { ($0.visualType == "event" || $0.visualType == "external_event") && $0.isSpanning }
            .compactMap { item in
                let start = CalendarDates.spanStart(item), end = CalendarDates.spanEnd(item)
                guard let placement = place(first: start, last: end, window: window) else { return nil }
                return EventRow(item: item, start: start, end: end, placement: placement)
            }
            .sorted { $0.start != $1.start ? $0.start < $1.start : $0.item.title.localizedStandardCompare($1.item.title) == .orderedAscending }
    }

    /// `buildTimelineGroups`.
    static func groups(
        tasks: [TaskItem],
        projects: [ProjectItem],
        events: [CalendarItem],
        window: Window,
        today: String,
        settings: TimelineSettings
    ) -> [Group] {
        let projectById = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var rows: [TaskRow] = []
        for task in tasks {
            if task.archivedAt != nil { continue }
            if task.completedAt != nil, !settings.showCompleted { continue }
            if task.parentId != nil, !settings.showSubtasks { continue }
            guard let project = projectById[task.projectId], project.archivedAt == nil else { continue }
            guard let row = row(task, project: project, window: window, today: today) else { continue }
            if case .none = row.shape, !settings.showUndated || row.isCompleted { continue }
            rows.append(row)
        }
        var groups: [Group] = []
        if settings.showEvents {
            let eventRows = eventRows(events, window: window)
            if !eventRows.isEmpty {
                groups.append(Group(id: "events", heading: .events, color: nil, rows: eventRows.map(Row.event), summary: nil))
            }
        }
        func push(_ id: String, _ heading: Heading, _ color: String?, _ members: [TaskRow]) {
            guard !members.isEmpty else { return }
            let ordered = nest(members, settings.orderBy).map(Row.task)
            groups.append(Group(id: id, heading: heading, color: color, rows: ordered, summary: summary(ordered)))
        }
        switch settings.groupBy {
        case .project:
            for project in projects where project.archivedAt == nil {
                push("project:\(project.id)", .project(id: project.id, name: project.name), project.color,
                     rows.filter { $0.task.projectId == project.id })
            }
        case .status:
            for status in statusOrder {
                push("status:\(status)", .status(status), nil, rows.filter { $0.statusType == status })
            }
        case .priority:
            for priority in priorityOrder {
                push("priority:\(priority)", .priority(priority), nil, rows.filter { $0.task.priority == priority })
            }
        case .none:
            push("all", .all, nil, rows)
        }
        return groups
    }
}
