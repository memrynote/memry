import Foundation

// JP032. The words the journal screens say, after desktop's
// `packages/i18n/src/locales/en/journal.json`, `settings.json` `journal.*`
// and `inbox.json` `reminder.presets.*`. Where a J-artboard and desktop
// differ, desktop's wording wins (D1). Literal copy, as the other
// `*Copy.swift` files are; per-screen additions go in
// `JournalCopy+<Screen>.swift`.

enum JournalCopy {
    static let title = "Journal"
    static let loading = "Opening the journal"

    // MARK: Dates (journal.json `date.*`)

    static let today = "Today"
    static let yesterday = "Yesterday"
    static let tomorrow = "Tomorrow"
    static let future = "Future"

    static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static let weekdaysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]
    static let monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// Month name, 1-12.
    static func monthName(_ month: Int) -> String {
        months[max(0, min(11, month - 1))]
    }

    static func monthShort(_ month: Int) -> String {
        monthsShort[max(0, min(11, month - 1))]
    }

    /// Weekday name, 0 = Sunday.
    static func weekdayName(_ weekday: Int) -> String {
        weekdays[((weekday % 7) + 7) % 7]
    }

    static func weekdayShort(_ weekday: Int) -> String {
        weekdaysShort[((weekday % 7) + 7) % 7]
    }

    /// The weekday line's relative part: "Today", "Yesterday", "Tomorrow",
    /// "3 days ago", "in 3 days" (J10's "Monday · 3 days ago").
    static func relative(days: Int) -> String {
        switch days {
        case 0: today
        case -1: yesterday
        case 1: tomorrow
        case ..<0: "\(-days) days ago"
        default: "in \(days) days"
        }
    }

    // MARK: Placeholders (journal.json `editor.placeholder.*`)

    static let placeholderToday = "What's on your mind today..."
    static let placeholderPast = "Reflect on this day..."
    static let placeholderFuture = "What are you planning..."

    // MARK: Navigation (journal.json `nav.*`, `action.*`)

    static let previousDay = "Previous day"
    static let nextDay = "Next day"
    static let previousMonth = "Previous month"
    static let nextMonth = "Next month"
    static let previousYear = "Previous year"
    static let nextYear = "Next year"
    static let goToToday = "Go to Today"
    static let goToYearView = "Go to year view"
    static let month = "Month"
    static let year = "Year"
    static let goToDate = "Go to date…"
    static let moreOptions = "More options"
    static let findInPage = "Find in page"
    static let export = "Export…"
    static let journalSettings = "Journal Settings"

    // MARK: Month and Year (journal.json `empty.*`, `count.*`)

    static let noEntry = "No entry"
    static let notOnThisPhone = "Not on this phone yet"
    static let daysWithEntries = "days with entries"
    static let charactersWritten = "characters written"

    static func entries(_ count: Int) -> String {
        count == 1 ? "1 entry" : "\(count) entries"
    }

    static func days(_ count: Int) -> String {
        count == 1 ? "1 day" : "\(count) days"
    }

    static func streak(_ count: Int) -> String {
        "\(count)-day streak"
    }

    static func best(_ count: Int) -> String {
        "best \(count)"
    }

    /// Desktop's Year totals: thousands as "318k" (`phaseF…k`).
    static func thousands(_ value: UInt64) -> String {
        value >= 1000 ? "\(value / 1000)k" : "\(value)"
    }

    // MARK: Stats footer (journal.json `stats.*`)

    static let lessThanOneMinute = "< 1 min"

    static func words(_ count: UInt64) -> String { "\(count) words" }
    static func characters(_ count: UInt64) -> String { "\(count) characters" }
    static func minutes(_ count: Int) -> String { "\(count) min" }
    static func read(_ time: String) -> String { "\(time) read" }
    static func modified(_ date: String) -> String { "Modified \(date)" }

    // MARK: Day section (journal.json `section.*`, `empty.*`, `count.*`)

    static let dueToday = "Due today"
    static func dueOn(_ date: String) -> String { "Due \(date)" }
    static let tasksFromThisDay = "Tasks from this day"
    static func overdue(_ count: Int) -> String { "\(count) overdue" }

    // MARK: Reminders (journal.json `reminder.*`, inbox.json presets)

    static let setToRevisit = "Set reminder to revisit"
    static let hasReminders = "Has reminders"
    static let reminderMenuTitle = "Remind me to revisit this day"
    static let pickDateAndTime = "Pick date & time…"
    static let presetInOneWeek = "In 1 Week"
    static let presetInOneMonth = "In 1 Month"
    static let presetInThreeMonths = "In 3 Months"
    static let presetInOneYear = "In 1 Year"
    static let reminderSet = "Reminder set for this journal entry"
    static let reminderUpdated = "Reminder updated"
    static let reminderDeleted = "Reminder deleted"
    static let reminderDismissed = "Reminder dismissed"
    static let reminderSnoozed = "Reminder snoozed"
    static let scheduledForThisDay = "Scheduled for this day"
    static let changeReminder = "Change reminder"
    static let remindMe = "Remind me"
    static let oneReminderRule =
        "A day keeps one reminder, as on desktop: saving moves the scheduled one. "
        + "The notification shows the date only, never what you wrote."

    /// D8: the notification never carries entry text.
    static let notificationTitle = "Journal reminder"
    static func notificationBody(longDate: String) -> String { "Revisit \(longDate)" }

    // MARK: Export (journal.json `export.noteTitle`)

    /// "Journal - September 24, 2026".
    static func exportTitle(month: Int, day: Int, year: Int) -> String {
        "Journal - \(monthName(month)) \(day), \(year)"
    }

    // MARK: Settings (settings.json `journal.*`)

    static let settingsDefaultTemplate = "Default Template"
    static let settingsTemplate = "Template"
    static let settingsTemplateDescription = "New entries start with this template"
    static let settingsTemplateNone = "None"
    static let settingsUnknownTemplate = "Unknown template"
    static let settingsWeekdayGroup = "Per-Day Templates"
    static let settingsWeekdayInherit = "Use default"
    static func settingsWeekdayInheritWith(_ name: String) -> String { "Default · \(name)" }
    static let settingsWeekdayInheritNone = "Default · none"
    static let settingsWeekdayMissing = "Deleted template"
    static func settingsWeekdaySummary(_ count: Int) -> String { "\(count) of 7 set" }
    static let settingsFooterGroup = "Footer"
    static let settingsShowStatsFooter = "Show Stats Footer"
    static let settingsShowStatsFooterDescription = "Word count, reading time, timestamps"

    // MARK: Limits

    /// D5, gate G0: why the tag and property rows cannot be edited here yet.
    static let metadataReadOnly =
        "Tags and properties on a journal day are read-only on iPhone for now. "
        + "Edit them in Memry on your computer."
}
