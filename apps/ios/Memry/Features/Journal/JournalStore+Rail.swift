import Foundation
import MemryCore

// #4351 (D8). "On this day" in the Journal rail: the shown day in other
// years (desktop `journal-past-years.tsx` over `getJournalSameDayEntries`).
// A pure read through the core; nothing is written or cached.

/// One other year's entry for the shown day.
struct JournalSameDayEntry: Equatable, Identifiable {
    let date: String
    let preview: String
    let level: UInt8
    var id: String { date }
}

/// Desktop `same-day.ts`: which dates show as the same day in another year.
/// A Feb 29 shows on Feb 28 of a year without one, and a Feb 28 of such a
/// year shows the Feb 29s.
enum JournalSameDay {
    static func matches(_ date: String, _ candidate: String) -> Bool {
        let target = split(date)
        let other = split(candidate)
        if other.year == target.year { return false }
        if other.monthDay == target.monthDay { return true }
        if target.monthDay == leapDay {
            return other.monthDay == dayBeforeLeapDay && !isLeap(other.year)
        }
        if target.monthDay == dayBeforeLeapDay, !isLeap(target.year) {
            return other.monthDay == leapDay
        }
        return false
    }

    private static let leapDay = "02-29"
    private static let dayBeforeLeapDay = "02-28"

    private static func split(_ date: String) -> (year: Int, monthDay: Substring) {
        (Int(date.prefix(4)) ?? 0, date.suffix(5))
    }

    private static func isLeap(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }
}

extension JournalStore {
    /// The same day in every other year, later ones included (desktop
    /// `getJournalSameDayEntries`), newest first, each with the core's preview. `nil` when the read failed (already reported).
    func sameDayEntries(_ date: String) async -> [JournalSameDayEntry]? {
        let today = today
        return await read { core in
            var months: [String: JournalMonthRecord] = [:]
            return try core.daysWithEntries(from: "1000-01-01", to: "9999-12-31")
                .filter { JournalSameDay.matches(date, $0) }
                .sorted(by: >)
                .compactMap { candidate in
                    let (year, month) = JournalDates.yearMonth(candidate)
                    let key = String(candidate.prefix(7))
                    let record = try months[key] ?? core.month(year: Int64(year), month: UInt32(month), today: today)
                    months[key] = record
                    guard let day = record.days.first(where: { $0.date == candidate }), day.hasEntry else { return nil }
                    return JournalSameDayEntry(date: candidate, preview: day.preview, level: day.level)
                }
        }
    }
}
