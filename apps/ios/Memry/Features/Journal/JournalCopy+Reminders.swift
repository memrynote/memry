import Foundation

// JP046. The reminder screens' words beyond `JournalCopy`'s reminder block
// (J07, J08, J13; desktop `journal.json` `reminder.*`).

extension JournalCopy {
    /// A preset or reminder row's time: "Thu, Oct 1 · 09:00".
    static func reminderWhen(day: String, time: String) -> String { "\(day) · \(time)" }

    /// Desktop's bell tooltip (`reminder.tooltip`, `reminder.tooltipMore`),
    /// read by VoiceOver on an active bell.
    static func reminderTooltip(_ date: String) -> String { "Reminder: \(date)" }
    static func reminderTooltipMore(_ date: String, more: Int) -> String { "Reminder: \(date) (+\(more) more)" }

    // MARK: J08 sheet

    static let reminderDate = "Date"
    static let reminderTime = "Time"
    static let reminderNote = "Note"
    static let reminderNoteOptional = "Optional"
    static let reminderSave = "Save reminder"
    static let reminderSwipeHint = "Swipe the reminder to delete it."
    static let reminderSnoozedState = "Snoozed"

    /// J08 footer: the one-reminder rule and the swipe hint.
    static var reminderSheetFooter: String { oneReminderRule + " " + reminderSwipeHint }

    // MARK: J13 notification

    /// The notification body's date: "Thursday, September 24" (long
    /// weekday, month, day; no year). `nil` for a key that is not a day.
    static func notificationLongDate(_ key: String) -> String? {
        guard let date = JournalDates.date(key) else { return nil }
        let weekday = JournalDates.calendar.component(.weekday, from: date) - 1
        let (_, month) = JournalDates.yearMonth(key)
        return "\(weekdayName(weekday)), \(monthName(month)) \(JournalDates.day(key))"
    }
}
