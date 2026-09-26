import Foundation
import os
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
        utcInstant(iso) ?? isoFormatter.date(from: iso) ?? isoPlain.date(from: iso)
    }

    /// The core's own shape, `YYYY-MM-DDTHH:MM:SS[.sss]Z`, by arithmetic.
    /// The grid reads every item's days on each pass; a formatter parse per
    /// call cost ~200 ms for a week of 200 items (CL092), this costs none.
    private static func utcInstant(_ iso: String) -> Date? {
        let bytes = Array(iso.utf8)
        guard bytes.count == 20 || bytes.count == 24, bytes.last == UInt8(ascii: "Z"),
              bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"), bytes[10] == UInt8(ascii: "T"),
              bytes[13] == UInt8(ascii: ":"), bytes[16] == UInt8(ascii: ":") else { return nil }
        func number(_ from: Int, _ count: Int) -> Int? {
            var value = 0
            for byte in bytes[from ..< from + count] {
                guard (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(byte) else { return nil }
                value = value * 10 + Int(byte - UInt8(ascii: "0"))
            }
            return value
        }
        guard let year = number(0, 4), let month = number(5, 2), let day = number(8, 2),
              let hour = number(11, 2), let minute = number(14, 2), let second = number(17, 2),
              (1 ... 12).contains(month), (1 ... 31).contains(day), hour < 24, minute < 60, second < 61 else { return nil }
        var millis = 0
        if bytes.count == 24 {
            guard bytes[19] == UInt8(ascii: "."), let fraction = number(20, 3) else { return nil }
            millis = fraction
        }
        // Days from civil (Howard Hinnant), proleptic Gregorian.
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146_097 + doe - 719_468
        let seconds = days * 86_400 + hour * 3600 + minute * 60 + second
        return Date(timeIntervalSince1970: TimeInterval(seconds) + TimeInterval(millis) / 1000)
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

    private struct SpanKey: Hashable {
        let start: String
        let end: String?
        let allDay: Bool
        let zone: String
    }

    /// Each item's first and last day, remembered: the grid, strips, month and
    /// year ask for them per day per item on every pass (CL092).
    private static let spanCache = OSAllocatedUnfairLock(initialState: [SpanKey: [String]]())

    private static func span(_ item: CalendarItem) -> [String] {
        let key = SpanKey(start: item.startAt, end: item.endAt, allDay: item.isAllDay, zone: TimeZone.current.identifier)
        if let hit = spanCache.withLock({ $0[key] }) { return hit }
        let value = [computeSpanStart(item), computeSpanEnd(item)]
        spanCache.withLock { cache in
            if cache.count > 4096 { cache.removeAll(keepingCapacity: true) }
            cache[key] = value
        }
        return value
    }

    static func spanStart(_ item: CalendarItem) -> String { span(item)[0] }

    /// `spanEndDateKey`: an all-day or midnight end is exclusive.
    static func spanEnd(_ item: CalendarItem) -> String { span(item)[1] }

    private static func computeSpanStart(_ item: CalendarItem) -> String {
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

    private static func computeSpanEnd(_ item: CalendarItem) -> String {
        let startKey = computeSpanStart(item)
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
