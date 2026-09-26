import Foundation

// Spec 007 CL023. What each view shows and loads (`pages/calendar.tsx`
// `getRangeForView`, `PERIOD_STEP`), plus the title and subtitle of artboards
// 01, 03, 04, 05, 07.

enum CalendarPeriods {
    /// The range a view loads. Day and Week share Week's window (the visible
    /// week ± one week), so paging days never refetches (goal "Performance").
    static func window(_ view: CalendarViewMode, anchor: String, weekStartsOn: Int, zoom: TimelineZoom) -> CalendarWindow {
        func span(_ from: String, _ to: String) -> CalendarWindow {
            CalendarWindow(
                startAt: CalendarDates.iso(CalendarDates.start(of: from)),
                endAt: CalendarDates.iso(CalendarDates.start(of: to))
            )
        }
        switch view {
        case .day, .week:
            let weekStart = CalendarDates.startOfWeek(anchor, weekStartsOn: weekStartsOn)
            return span(CalendarDates.addDays(weekStart, -7), CalendarDates.addDays(weekStart, 14))
        case .month:
            let grid = CalendarDates.monthGrid(anchor, weekStartsOn: weekStartsOn)
            return span(grid.first ?? anchor, CalendarDates.addDays(grid.last ?? anchor, 1))
        case .year:
            let year = String(anchor.prefix(4))
            let next = CalendarDates.addYears("\(year)-01-01", 1)
            return span("\(year)-01-01", next)
        case .timeline:
            let window = TimelineModel.window(anchor: anchor, zoom: zoom, weekStartsOn: weekStartsOn)
            return span(window.start, CalendarDates.addDays(window.end, 1))
        }
    }

    /// `PERIOD_STEP`.
    static func step(_ view: CalendarViewMode, anchor: String, direction: Int, zoom: TimelineZoom) -> String {
        switch view {
        case .day: CalendarDates.addDays(anchor, direction)
        case .week: CalendarDates.addDays(anchor, 7 * direction)
        case .month: CalendarDates.addMonths(anchor, direction)
        case .year: CalendarDates.addYears(anchor, direction)
        case .timeline: TimelineModel.step(anchor: anchor, zoom: zoom, direction: direction)
        }
    }

    /// The large title: the month (Day, Week, Month, Timeline) or the year.
    static func title(_ view: CalendarViewMode, anchor: String) -> String {
        let date = CalendarDates.start(of: anchor)
        if view == .year { return date.formatted(.dateTime.year()) }
        if view == .timeline { return CalendarCopy.view(.timeline) }
        return date.formatted(.dateTime.month(.wide))
    }

    /// "Day · Thursday, Sep 24", "Week · Sep 21 – 27", "Month · 2026".
    static func subtitle(_ view: CalendarViewMode, anchor: String, weekStartsOn: Int) -> String {
        let date = CalendarDates.start(of: anchor)
        let name = CalendarCopy.view(view)
        switch view {
        case .day:
            return "\(name) · \(date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))"
        case .week:
            let first = CalendarDates.startOfWeek(anchor, weekStartsOn: weekStartsOn)
            let last = CalendarDates.addDays(first, 6)
            let range = CalendarDates.start(of: first)..<CalendarDates.start(of: last).addingTimeInterval(1)
            return "\(name) · \(range.formatted(.interval.month(.abbreviated).day()))"
        case .month, .timeline:
            return "\(name) · \(date.formatted(.dateTime.year()))"
        case .year:
            return "\(name) · \(CalendarCopy.yearHint)"
        }
    }
}
