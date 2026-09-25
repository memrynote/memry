import Foundation

// JP042–JP044. The words the title menu, Go to date, Month (J05) and Year
// (J06) say beyond `JournalCopy`: the subtitles, the go-to-date sheet and the
// VoiceOver sentences of JP057.

extension JournalCopy {
    /// The dot between subtitle parts ("2026 · 17 entries").
    static let subtitleSeparator = " · "

    // MARK: Title menu (J04)

    /// "September 2026", the Month row's title.
    static func monthAndYear(year: Int, month: Int) -> String {
        "\(monthName(month)) \(year)"
    }

    // MARK: Go to date

    static let goToDateTitle = "Go to date"
    static let goToDateConfirm = "Go to this date"
    static let goToDateCancel = "Cancel"
    static let goToDatePicker = "Date"

    // MARK: Month (J05)

    /// "Thursday 24, entry, Slept well…" (JP057).
    static func monthRowAccessibility(weekday: String, day: Int, status: String) -> String {
        "\(weekday) \(day), \(status)"
    }

    static let entryAccessibility = "entry"
    static let openDayHint = "Opens this day"

    // MARK: Year (J06)

    /// "September, 17 days" (JP057).
    static func yearCardAccessibility(month: Int, entryCount: Int) -> String {
        "\(monthName(month)), \(days(entryCount))"
    }

    static let currentMonth = "Current month"
    static let openMonthHint = "Opens this month"
}
