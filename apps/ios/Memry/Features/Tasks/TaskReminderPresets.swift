import Foundation

// TP053. The reminder picker's presets and how a reminder time reads, after
// desktop's `components/reminder/reminder-presets.ts`.
//
// These are the picker's own wall-clock suggestions (a renderer helper on
// desktop, not a shared task rule): the core has no preset call, and the
// resolved instant is handed to the core, which validates it (future only)
// and stores it in `toISOString` form.

/// A preset reminder time.
struct TaskReminderPreset: Identifiable, Equatable {
    let id: String
    let label: String
    let detail: String?
    let date: Date
}

enum TaskReminderPresets {
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    /// Desktop `standardPresets`: later today, tomorrow, next week, in a month.
    static func standard(now: Date) -> [TaskReminderPreset] {
        [
            TaskReminderPreset(
                id: "later-today",
                label: TasksCopy.reminderPresetLaterToday,
                detail: TasksCopy.reminderPresetInHours(4),
                date: laterToday(now)
            ),
            TaskReminderPreset(
                id: "tomorrow",
                label: TasksCopy.reminderPresetTomorrow,
                detail: TasksCopy.reminderPresetTomorrowDetail,
                date: inDays(1, hour: 9, from: now)
            ),
            TaskReminderPreset(
                id: "next-week",
                label: TasksCopy.reminderPresetNextWeek,
                detail: TasksCopy.reminderPresetNextWeekDetail,
                date: nextMonday(hour: 9, from: now)
            ),
            TaskReminderPreset(
                id: "in-one-month",
                label: TasksCopy.reminderPresetInOneMonth,
                detail: TasksCopy.reminderPresetSameDayNextMonth,
                date: inMonths(1, hour: 9, from: now)
            )
        ]
    }

    /// Desktop's reminder `snoozePresets`: 15 minutes, 1 hour, 3 hours,
    /// tomorrow morning.
    static func snooze(now: Date) -> [TaskReminderPreset] {
        [
            TaskReminderPreset(
                id: "in-15-min",
                label: TasksCopy.reminderSnoozeInMinutes(15),
                detail: nil,
                date: now.addingTimeInterval(15 * 60)
            ),
            TaskReminderPreset(
                id: "in-1-hour",
                label: TasksCopy.reminderSnoozeInHours(1),
                detail: nil,
                date: now.addingTimeInterval(60 * 60)
            ),
            TaskReminderPreset(
                id: "in-3-hours",
                label: TasksCopy.reminderSnoozeInHours(3),
                detail: nil,
                date: now.addingTimeInterval(3 * 60 * 60)
            ),
            TaskReminderPreset(
                id: "tomorrow-morning",
                label: TasksCopy.reminderSnoozeTomorrowMorning,
                detail: nil,
                date: inDays(1, hour: 9, from: now)
            )
        ]
    }

    /// Desktop `getLaterToday`: four hours on the hour; 8 PM after 5 PM;
    /// tomorrow 9 AM after 8 PM.
    static func laterToday(_ now: Date) -> Date {
        let hour = calendar.component(.hour, from: now)
        if hour >= 20 { return inDays(1, hour: 9, from: now) }
        if hour >= 17 { return at(hour: 20, on: now) }
        return at(hour: hour + 4, on: now)
    }

    /// Desktop `getNextMonday`: Sunday → tomorrow, Monday → a week out.
    static func nextMonday(hour: Int, from now: Date) -> Date {
        let weekday = calendar.component(.weekday, from: now) - 1 // 0 = Sunday
        let untilMonday = (8 - weekday) % 7
        let days = weekday == 0 ? 1 : (untilMonday == 0 ? 7 : untilMonday)
        return inDays(days, hour: hour, from: now)
    }

    static func inDays(_ days: Int, hour: Int, from now: Date) -> Date {
        let day = calendar.date(byAdding: .day, value: days, to: now) ?? now
        return at(hour: hour, on: day)
    }

    static func inMonths(_ months: Int, hour: Int, from now: Date) -> Date {
        let day = calendar.date(byAdding: .month, value: months, to: now) ?? now
        return at(hour: hour, on: day)
    }

    private static func at(hour: Int, on day: Date) -> Date {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
    }

    /// Desktop `formatReminderDate`: "Today at 3:00 PM", "Tomorrow at …",
    /// the weekday within a week, else "Jan 5" (with the year when it differs).
    static func text(_ date: Date, now: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return TasksCopy.reminderTodayAt(time) }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) {
            return TasksCopy.reminderTomorrowAt(time)
        }
        let daysUntil = Int((date.timeIntervalSince(now) / 86400).rounded(.up))
        let day: String
        if daysUntil < 7 {
            day = date.formatted(.dateTime.weekday(.wide))
        } else if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            day = date.formatted(.dateTime.month(.abbreviated).day())
        } else {
            day = date.formatted(.dateTime.month(.abbreviated).day().year())
        }
        return TasksCopy.reminderDateAt(day, time)
    }

    /// A stored ISO instant (`remindAt`, `snoozedUntil`) as a `Date`.
    static func instant(_ iso: String) -> Date? {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let date = try? fractional.parse(iso) { return date }
        return try? Date.ISO8601FormatStyle().parse(iso)
    }
}
