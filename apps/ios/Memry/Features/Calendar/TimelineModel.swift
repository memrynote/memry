import Foundation
import MemryCore

// Spec 007 CL014/CL034. Desktop's `timeline-model.ts`, ported to Swift (§6
// CL014: it is pure view math over the task list the Tasks store already
// holds, and its unit tests in `CalendarTimelineTests` restate
// `timeline-model.test.ts`'s cases).

enum TimelineModel {
    /// `TIMELINE_DAY_WIDTH`.
    /// Desktop's `TIMELINE_DAY_WIDTH` is 48 / 26 / 8 for a wide window; a
    /// phone's canvas is about 260 pt, so Paper 07 scales it to show roughly
    /// two weeks / six weeks / four months (§6 CL034).
    static func dayWidth(_ zoom: TimelineZoom) -> Double {
        switch zoom {
        case .weeks: 20
        case .months: 7
        case .quarters: 2.5
        }
    }

    /// `OPEN_ENDED_DAYS`.
    static let openEndedDays = 5

    struct Window: Equatable {
        let start: String
        let end: String
        var dayCount: Int { CalendarDates.dayIndex(end) - CalendarDates.dayIndex(start) + 1 }
    }

    static func startOfMonth(_ date: String) -> String { String(date.prefix(7)) + "-01" }

    static func startOfQuarter(_ date: String) -> String {
        let month = Int(date.dropFirst(5).prefix(2)) ?? 1
        return String(format: "%@-%02d-01", String(date.prefix(4)), ((month - 1) / 3) * 3 + 1)
    }

    /// `getTimelineWindow`.
    static func window(anchor: String, zoom: TimelineZoom, weekStartsOn: Int) -> Window {
        switch zoom {
        case .weeks:
            let weekStart = CalendarDates.startOfWeek(anchor, weekStartsOn: weekStartsOn)
            return Window(start: CalendarDates.addDays(weekStart, -21), end: CalendarDates.addDays(weekStart, 7 * 7 - 1))
        case .months:
            let month = startOfMonth(anchor)
            return Window(start: CalendarDates.addMonths(month, -2), end: CalendarDates.addDays(CalendarDates.addMonths(month, 4), -1))
        case .quarters:
            let quarter = startOfQuarter(anchor)
            return Window(start: CalendarDates.addMonths(quarter, -6), end: CalendarDates.addDays(CalendarDates.addMonths(quarter, 12), -1))
        }
    }

    /// `stepTimelineAnchor`.
    static func step(anchor: String, zoom: TimelineZoom, direction: Int) -> String {
        switch zoom {
        case .weeks: CalendarDates.addDays(anchor, 7 * direction)
        case .months: CalendarDates.addMonths(anchor, direction)
        case .quarters: CalendarDates.addMonths(anchor, 3 * direction)
        }
    }

    static func offset(_ date: String, _ window: Window) -> Int {
        CalendarDates.dayIndex(date) - CalendarDates.dayIndex(window.start)
    }

    // MARK: Shapes

    enum Shape: Equatable {
        case span(start: String, end: String)
        case due(String)
        case start(String)
        case none
    }

    /// `toTimelineShape`.
    static func shape(start: String?, due: String?) -> Shape {
        let start = start.map { String($0.prefix(10)) }
        let due = due.map { String($0.prefix(10)) }
        if let start, let due, start < due { return .span(start: start, end: due) }
        if let due { return .due(due) }
        if let start { return .start(start) }
        return .none
    }

    /// `shapeBounds`.
    static func bounds(_ shape: Shape) -> (first: String, last: String)? {
        switch shape {
        case let .span(start, end): (start, end)
        case let .due(date): (date, date)
        case let .start(date): (date, CalendarDates.addDays(date, openEndedDays - 1))
        case .none: nil
        }
    }

    struct Placement: Equatable {
        let from: Int
        let to: Int
        let clippedStart: Bool
        let clippedEnd: Bool
    }

    /// `placeInWindow`.
    static func place(first: String, last: String, window: Window) -> Placement? {
        if last < window.start || first > window.end { return nil }
        let clippedStart = first < window.start, clippedEnd = last > window.end
        return Placement(
            from: clippedStart ? 0 : offset(first, window),
            to: clippedEnd ? window.dayCount - 1 : offset(last, window),
            clippedStart: clippedStart,
            clippedEnd: clippedEnd
        )
    }

    // MARK: Edits

    struct Dates: Equatable {
        var start: String?
        var due: String?
    }

    enum Edit { case move, resizeStart, resizeEnd }

    static func dates(_ shape: Shape) -> Dates {
        switch shape {
        case let .span(start, end): Dates(start: start, due: end)
        case let .due(date): Dates(start: nil, due: date)
        case let .start(date): Dates(start: date, due: nil)
        case .none: Dates()
        }
    }

    /// `applyTimelineEdit`.
    static func apply(_ shape: Shape, _ edit: Edit, deltaDays: Int) -> Dates {
        let current = dates(shape)
        if case .none = shape { return current }
        guard deltaDays != 0 else { return current }
        let shift = { (date: String?) in date.map { CalendarDates.addDays($0, deltaDays) } }
        switch edit {
        case .move:
            return Dates(start: shift(current.start), due: shift(current.due))
        case .resizeEnd:
            if case let .span(start, end) = shape {
                let due = CalendarDates.addDays(end, deltaDays)
                return Dates(start: start, due: due < start ? start : due)
            }
            guard let anchor = current.due ?? current.start else { return current }
            let due = CalendarDates.addDays(anchor, deltaDays)
            return due <= anchor ? current : Dates(start: anchor, due: due)
        case .resizeStart:
            if case let .span(start, end) = shape {
                let moved = CalendarDates.addDays(start, deltaDays)
                return Dates(start: moved > end ? end : moved, due: end)
            }
            if case let .start(date) = shape { return Dates(start: CalendarDates.addDays(date, deltaDays), due: nil) }
            guard let date = current.due else { return current }
            let moved = CalendarDates.addDays(date, deltaDays)
            return moved >= date ? current : Dates(start: moved, due: date)
        }
    }

    /// `scheduleRange`: a tap dates it, a range gives start and due.
    static func schedule(from: String, to: String) -> Dates {
        if from == to { return Dates(start: nil, due: from) }
        return from < to ? Dates(start: from, due: to) : Dates(start: to, due: from)
    }

    // MARK: Rows and groups

    struct TaskRow: Identifiable, Equatable {
        var id: String { "task:\(task.id)" }
        let task: TaskItem
        var depth: Int
        let shape: Shape
        let placement: Placement?
        let isOverdue: Bool
        let isCompleted: Bool
        let statusType: String
        let projectName: String
        let color: String
    }

    struct EventRow: Identifiable, Equatable {
        var id: String { "event:\(item.projectionId)" }
        let item: CalendarItem
        let start: String
        let end: String
        let placement: Placement
    }

    enum Row: Identifiable, Equatable {
        case task(TaskRow)
        case event(EventRow)
        var id: String {
            switch self {
            case let .task(row): row.id
            case let .event(row): row.id
            }
        }
        var placement: Placement? {
            switch self {
            case let .task(row): row.placement
            case let .event(row): row.placement
            }
        }
    }

    enum Heading: Equatable {
        case events
        case project(id: String, name: String)
        case status(String)
        case priority(Int64)
        case all
    }

    struct Group: Identifiable, Equatable {
        let id: String
        let heading: Heading
        let color: String?
        let rows: [Row]
        let summary: Placement?
    }
}
