import Foundation
import MemryCore

// Spec 007 CL015. The local-calendar arithmetic the views share, in the
// shapes desktop's `date-utils.ts` uses: a day is a `YYYY-MM-DD` key in the
// user's zone, an instant is an ISO string in UTC with milliseconds
// (`toISOString()`), which is what the core compares and sorts.

enum CalendarDates {
    /// The user's calendar, fixed to the Gregorian system desktop computes in.
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    // ISO8601DateFormatter is documented thread-safe once configured.
    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    nonisolated(unsafe) private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// `Date.toISOString()`.
    static func iso(_ date: Date) -> String { isoFormatter.string(from: date) }

    /// An ISO instant (with or without fractions or an offset).
    static func date(_ iso: String) -> Date? {
        isoFormatter.date(from: iso) ?? isoPlain.date(from: iso)
    }

    /// `toLocalDateString`.
    static func key(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// `parseLocalDate`: local midnight of a day key.
    static func start(of key: String) -> Date {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return Date() }
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        return calendar.date(from: components) ?? Date()
    }

    static func addDays(_ key: String, _ amount: Int) -> String {
        Self.key(calendar.date(byAdding: .day, value: amount, to: start(of: key)) ?? start(of: key))
    }

    static func addMonths(_ key: String, _ amount: Int) -> String {
        Self.key(calendar.date(byAdding: .month, value: amount, to: start(of: key)) ?? start(of: key))
    }

    static func addYears(_ key: String, _ amount: Int) -> String {
        Self.key(calendar.date(byAdding: .year, value: amount, to: start(of: key)) ?? start(of: key))
    }

    /// `getDay()`: 0 = Sunday.
    static func weekday(_ key: String) -> Int {
        calendar.component(.weekday, from: start(of: key)) - 1
    }

    /// `getStartOfWeek`.
    static func startOfWeek(_ key: String, weekStartsOn: Int) -> String {
        addDays(key, -((weekday(key) - weekStartsOn + 7) % 7))
    }

    /// `getMonthGridDays`: whole weeks covering the anchor's month.
    static func monthGrid(_ key: String, weekStartsOn: Int) -> [String] {
        let first = String(key.prefix(7)) + "-01"
        let leading = (weekday(first) - weekStartsOn + 7) % 7
        let days = calendar.range(of: .day, in: .month, for: start(of: first))?.count ?? 30
        let cells = Int((Double(leading + days) / 7).rounded(.up)) * 7
        return (0 ..< cells).map { addDays(first, $0 - leading) }
    }

    /// `dayIndexFromDate` relative to 2020-01-01, zone-free.
    static func dayIndex(_ key: String) -> Int {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return 0 }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date()
        let epoch = utc.date(from: DateComponents(year: 2020, month: 1, day: 1)) ?? Date()
        return Int((date.timeIntervalSince(epoch) / 86_400).rounded())
    }

    static func isWeekend(_ key: String) -> Bool {
        let day = weekday(key)
        return day == 0 || day == 6
    }

    // MARK: Spans (`date-utils.ts`)

    static func spanStart(_ item: CalendarItem) -> String {
        if isUtcAllDay(item) { return String(item.startAt.prefix(10)) }
        return date(item.startAt).map(key) ?? String(item.startAt.prefix(10))
    }

    /// An imported all-day event is stored at UTC midnights (Google's and
    /// iCalendar's DATE, desktop `toInstant`), so its days are the UTC ones.
    /// Read as local days it would spill into a second day east of UTC and
    /// start a day early west of it (§6 CL051). Memry's own all-day items
    /// carry local midnights and keep the local reading.
    static func isUtcAllDay(_ item: CalendarItem) -> Bool {
        guard item.isAllDay, let start = date(item.startAt) else { return false }
        let startsAtUtcMidnight = Int64(start.timeIntervalSince1970).isMultiple(of: 86_400)
        let endsAtUtcMidnight = item.endAt.flatMap(date).map { Int64($0.timeIntervalSince1970).isMultiple(of: 86_400) } ?? true
        return startsAtUtcMidnight && endsAtUtcMidnight && TimeZone.current.secondsFromGMT(for: start) != 0
    }

    /// `spanEndDateKey`: an all-day or midnight end is exclusive.
    static func spanEnd(_ item: CalendarItem) -> String {
        let startKey = spanStart(item)
        guard let endText = item.endAt, let end = date(endText) else { return startKey }
        if isUtcAllDay(item) {
            let last = String(CalendarDates.iso(end.addingTimeInterval(-1)).prefix(10))
            return last < startKey ? startKey : last
        }
        let parts = calendar.dateComponents([.hour, .minute, .second, .nanosecond], from: end)
        let midnight = parts.hour == 0 && parts.minute == 0 && parts.second == 0 && (parts.nanosecond ?? 0) < 1_000_000
        let inclusive = item.isAllDay || midnight ? end.addingTimeInterval(-0.001) : end
        let endKey = key(inclusive)
        return endKey < startKey ? startKey : endKey
    }

    static func spanDays(_ item: CalendarItem) -> Int {
        min(max(dayIndex(spanEnd(item)) - dayIndex(spanStart(item)) + 1, 1), 400)
    }

    static func isMultiDay(_ item: CalendarItem) -> Bool { spanDays(item) > 1 }

    static func covers(_ item: CalendarItem, _ day: String) -> Bool {
        day >= spanStart(item) && day <= spanEnd(item)
    }

    /// Minutes since local midnight.
    static func minutes(_ date: Date) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    // MARK: Zone for the core

    /// The zone over `[from, to]` as the core takes it (spec 007 §6 CL002):
    /// the offset before the window, then each DST transition inside it.
    static func zone(from: Date, to: Date, timeZone: TimeZone = .current) -> CalendarZone {
        let start = from.addingTimeInterval(-3 * 86_400)
        let end = to.addingTimeInterval(3 * 86_400)
        var transitions: [CalendarZoneTransition] = []
        var cursor = start
        while let next = timeZone.nextDaylightSavingTimeTransition(after: cursor), next <= end {
            transitions.append(CalendarZoneTransition(
                atMs: Int64(next.timeIntervalSince1970 * 1000),
                offsetMs: Int64(timeZone.secondsFromGMT(for: next)) * 1000
            ))
            cursor = next.addingTimeInterval(1)
        }
        return CalendarZone(
            identifier: timeZone.identifier,
            baseOffsetMs: Int64(timeZone.secondsFromGMT(for: start)) * 1000,
            transitions: transitions
        )
    }
}
