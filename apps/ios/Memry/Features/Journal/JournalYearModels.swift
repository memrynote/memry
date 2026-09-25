import MemryCore

// JP044. What a Year card (J06) and the Year subtitle say, from the core's
// `JournalYearRecord`. Counts, dots and totals are the core's; the current
// and future flags compare the card with the journal's today (D3).

/// One month card, ready to draw.
struct JournalYearCardModel: Equatable, Identifiable {
    /// 1-12.
    let month: Int
    let entryCount: Int
    /// Five activity levels (0-4), one per 7-day block; missing blocks are 0.
    let dots: [UInt8]
    let isCurrent: Bool
    let isFuture: Bool

    var id: Int { month }

    static let dotCount = 5

    init(_ card: JournalMonthCard, year: Int, today: String) {
        month = Int(card.month) + 1
        entryCount = Int(card.entryCount)
        let levels = Array(card.activityDots.prefix(Self.dotCount))
        dots = levels + Array(repeating: 0, count: Self.dotCount - levels.count)
        let now = JournalDates.yearMonth(today)
        isCurrent = year == now.year && month == now.month
        isFuture = (year, month) > (now.year, now.month)
    }

    /// "September, 17 days" (JP057).
    var accessibilityLabel: String {
        JournalCopy.yearCardAccessibility(month: month, entryCount: entryCount)
    }
}

/// The line under the Year title: "135 days · 6-day streak · best 21". The
/// streak part is drawn in the tint (Paper J06), so it is kept apart.
struct JournalYearSubtitle: Equatable {
    let lead: String
    /// `nil` when no streak is running.
    let streak: String?
    /// `nil` before the first entry.
    let best: String?

    init(daysWithEntries: Int, streak current: Int, best longest: Int) {
        lead = JournalCopy.days(daysWithEntries)
        streak = current > 0 ? JournalCopy.streak(current) : nil
        best = longest > 0 ? JournalCopy.best(longest) : nil
    }

    init(_ record: JournalYearRecord) {
        self.init(
            daysWithEntries: Int(record.daysWithEntries),
            streak: Int(record.streak.current),
            best: Int(record.streak.longest)
        )
    }

    var text: String {
        [lead, streak, best].compactMap(\.self).joined(separator: JournalCopy.subtitleSeparator)
    }
}
