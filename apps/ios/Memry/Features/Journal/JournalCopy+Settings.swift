import Foundation

// JP048. Settings › Journal copy beyond `JournalCopy`'s settings block, after
// desktop's `settings.json` `journal.*` and Paper J11, J12.

extension JournalCopy {
    /// J11's title, desktop's `journal.header.title`.
    static let settingsTitle = "Journal"
    /// Desktop's `journal.header.loading`.
    static let settingsLoading = "Loading settings…"

    /// The weekday group's header: "Per-Day Templates · 2 of 7 set".
    static func settingsWeekdayHeader(_ count: Int) -> String {
        "\(settingsWeekdayGroup) · \(settingsWeekdaySummary(count))"
    }

    /// J12's rule under the list: the choice is bound to the absolute weekday.
    static func settingsWeekdayRule(_ weekday: Int) -> String {
        "Every \(weekdayName(weekday)) entry starts from this template. "
            + "Changing which day your week starts on does not move it."
    }

    /// D9: the stats footer switch is not a synced setting.
    static let settingsStatsFooterDevice = "Kept on this iPhone for this vault."

    /// VoiceOver: a weekday row, "Saturday, Weekend review".
    static func settingsWeekdayAccessibility(_ weekday: Int, value: String) -> String {
        "\(weekdayName(weekday)), \(value)"
    }

    // MARK: More tab

    static let settingsMoreRow = "Journal"
    static let settingsMoreDetail = "Default template, a template per day, stats footer"
}
