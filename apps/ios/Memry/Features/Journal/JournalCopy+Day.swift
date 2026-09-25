import Foundation

// JP040, JP041, JP051. The Day page's words: the date header, the placeholder
// choice, the ghost row, the "Today" capsule, the stats footer line and the
// keyboard shortcut titles. Desktop wording (`journal.json`) where desktop
// has the string (D1).

extension JournalCopy {
    // MARK: Date header (J01, J10)

    /// Weekday, 0 = Sunday, of a `YYYY-MM-DD` key.
    static func weekday(of date: String) -> Int {
        guard let day = JournalDates.date(date) else { return 0 }
        return JournalDates.calendar.component(.weekday, from: day) - 1
    }

    /// The line above the title: "Thursday" on today (the TODAY badge says
    /// the rest), "Monday · 3 days ago" off today (J10).
    static func weekdayLine(date: String, today: String) -> String {
        let name = weekdayName(weekday(of: date))
        let offset = JournalDates.days(from: today, to: date)
        return offset == 0 ? name : "\(name) · \(relative(days: offset))"
    }

    /// The serif title: "September 24".
    static func dayTitle(_ date: String) -> String {
        "\(monthName(JournalDates.yearMonth(date).month)) \(JournalDates.day(date))"
    }

    /// The inline navigation title after scroll: "Thu, Sep 24" (J03).
    static func inlineTitle(_ date: String) -> String {
        let month = monthShort(JournalDates.yearMonth(date).month)
        return "\(weekdayShort(weekday(of: date))), \(month) \(JournalDates.day(date))"
    }

    /// VoiceOver reads the header as one heading:
    /// "Thursday, September 24, 2099, Today".
    static func headerLabel(date: String, today: String) -> String {
        let (year, _) = JournalDates.yearMonth(date)
        let base = "\(weekdayName(weekday(of: date))), \(dayTitle(date)), \(year)"
        return "\(base), \(relative(days: JournalDates.days(from: today, to: date)))"
    }

    static let todayBadge = "TODAY"
    static let titleMenuHint = "Opens Month, Year and Go to date"

    // MARK: Placeholder (journal.json `editor.placeholder.*`)

    /// Desktop picks the placeholder by the day's place relative to today.
    static func placeholder(date: String, today: String) -> String {
        let offset = JournalDates.days(from: today, to: date)
        if offset == 0 { return placeholderToday }
        return offset < 0 ? placeholderPast : placeholderFuture
    }

    static let firstLineLabel = "Write in this day"
    static let loadingDay = "Opening this day"

    // MARK: Ghost row (J01)

    static let ghostTag = "Tag"
    static let ghostProperty = "Property"
    static let addTag = "Add tag"
    static let addProperty = "Add property"
    static let metadataReadOnlyHint = "Read-only on iPhone for now"

    // MARK: Navigation (J10)

    static let backToMonth = "Back to month"
    static let closeFind = "Close find"

    // MARK: Stats footer (journal.json `stats.*`, `count.*`)

    /// Desktop reads at 200 words a minute, rounds up, and says "< 1 min"
    /// only for an empty entry (`journal-stats-footer.tsx`).
    static func readingTime(words: UInt64) -> String {
        let minutes = Int((words + 199) / 200)
        return minutes < 1 ? lessThanOneMinute : self.minutes(minutes)
    }

    /// Desktop's modified label: the modified instant (else the created one)
    /// as a medium date, "—" when the payload carried neither.
    static func modifiedDate(modifiedAt: Int64?, createdAt: Int64?) -> String {
        guard let milliseconds = modifiedAt ?? createdAt else { return "—" }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
            .formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// "142 words · 812 characters · 1 min read · Modified Sep 24, 2099".
    static func statsLine(words: UInt64, characters: UInt64, modifiedAt: Int64?, createdAt: Int64?) -> String {
        [
            self.words(words),
            self.characters(characters),
            read(readingTime(words: words)),
            modified(modifiedDate(modifiedAt: modifiedAt, createdAt: createdAt))
        ].joined(separator: " · ")
    }

    static let documentStatistics = "Document statistics"
}
