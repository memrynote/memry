import Foundation
import MemryCore

// JP046 (J07). The bell menu's presets and how a reminder time reads.
//
// Desktop `journalPresets` (`components/reminder/reminder-presets.ts:191-230`):
// in 1 week, 1 month, 3 months and 1 year, each at 09:00 local, counted from
// now (not from the day the reminder is on). The date math follows desktop's
// JS `Date` exactly: `getInDays` is `setDate(getDate() + n)` and
// `getInMonths` is `setMonth(getMonth() + n)`, which keeps the day of month
// and overflows into the next month (Jan 31 + 1 month = Mar 3), then
// `setHours(9, 0, 0, 0)`. Foundation's month arithmetic clamps instead, so
// it is not used here.

/// A journal preset reminder time.
struct JournalReminderPreset: Identifiable, Equatable {
    let id: String
    let label: String
    let date: Date
}

enum JournalReminderPresets {
    /// Desktop's preset hour.
    static let hour = 9

    /// Desktop `journalPresets`, resolved against `now`.
    static func all(now: Date, calendar: Calendar = JournalDates.calendar) -> [JournalReminderPreset] {
        [
            JournalReminderPreset(
                id: "in-one-week",
                label: JournalCopy.presetInOneWeek,
                date: inDays(7, from: now, calendar: calendar)
            ),
            JournalReminderPreset(
                id: "in-one-month",
                label: JournalCopy.presetInOneMonth,
                date: inMonths(1, from: now, calendar: calendar)
            ),
            JournalReminderPreset(
                id: "in-three-months",
                label: JournalCopy.presetInThreeMonths,
                date: inMonths(3, from: now, calendar: calendar)
            ),
            JournalReminderPreset(
                id: "in-one-year",
                label: JournalCopy.presetInOneYear,
                date: inMonths(12, from: now, calendar: calendar)
            )
        ]
    }

    /// Desktop `getInDays(days, 9)`.
    static func inDays(_ days: Int, from now: Date, calendar: Calendar = JournalDates.calendar) -> Date {
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        let day = parts.day ?? 1
        return atHour(year: parts.year ?? 1970, month: parts.month ?? 1, dayOffset: day - 1 + days, calendar) ?? now
    }

    /// Desktop `getInMonths(months, 9)`: the day of month overflows as JS
    /// `setMonth` does.
    static func inMonths(_ months: Int, from now: Date, calendar: Calendar = JournalDates.calendar) -> Date {
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        let index = (parts.month ?? 1) - 1 + months
        let yearShift = index >= 0 ? index / 12 : (index - 11) / 12
        let month = index - yearShift * 12 + 1
        let day = parts.day ?? 1
        return atHour(year: (parts.year ?? 1970) + yearShift, month: month, dayOffset: day - 1, calendar) ?? now
    }

    /// `hour`:00 local on the first of `month` moved by `dayOffset` days.
    private static func atHour(year: Int, month: Int, dayOffset: Int, _ calendar: Calendar) -> Date? {
        guard let first = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
              let day = calendar.date(byAdding: .day, value: dayOffset, to: first) else { return nil }
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
    }

    /// J07/J08 "Thu, Oct 1 · 09:00", with the year when it is not this
    /// year's ("Fri, Sep 24, 2027 · 09:00"). The time follows the phone's
    /// 12/24-hour setting, as desktop's follows its clock-format setting.
    static func text(
        _ date: Date,
        now: Date,
        locale: Locale = .autoupdatingCurrent,
        calendar: Calendar = JournalDates.calendar
    ) -> String {
        var dayStyle = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .weekday(.abbreviated).month(.abbreviated).day()
        if calendar.component(.year, from: date) != calendar.component(.year, from: now) {
            dayStyle = dayStyle.year()
        }
        let timeStyle = Date.FormatStyle(
            date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone
        )
        return JournalCopy.reminderWhen(day: date.formatted(dayStyle), time: date.formatted(timeStyle))
    }

    /// When a reminder fires next: the snooze time while snoozed.
    static func fireDate(_ reminder: JournalReminder) -> Date? {
        if reminder.status == "snoozed", let until = reminder.snoozedUntil,
           let date = TaskReminderPresets.instant(until) {
            return date
        }
        return TaskReminderPresets.instant(reminder.remindAt)
    }
}
