import MemryCore

// JP043. What a Month row (J05) and the Month subtitle say, from the core's
// `JournalMonthDayRecord` and `JournalMonthRecord`. The rules (level,
// preview, today, future) are the core's; this only picks the words.

/// What a Month row shows after its day number and weekday.
enum JournalMonthRowState: Equatable {
    /// A day with text: its preview.
    case entry(preview: String)
    /// The day exists but its body has not reached this phone yet.
    case notPulled
    /// A day after today with nothing written.
    case future
    /// A past (or today's) day with nothing written.
    case noEntry

    /// After desktop's `journal-entry-list-item.tsx`: a preview when the day
    /// has one, else "Future" after today, else "No entry". A body that is
    /// not on this phone says so first (its preview would read empty).
    init(_ day: JournalMonthDayRecord) {
        if day.body == .notPulled {
            self = .notPulled
        } else if day.hasEntry, !day.preview.isEmpty {
            self = .entry(preview: day.preview)
        } else if day.isFuture {
            self = .future
        } else {
            self = .noEntry
        }
    }

    /// The row's trailing text.
    var text: String {
        switch self {
        case let .entry(preview): preview
        case .notPulled: JournalCopy.notOnThisPhone
        case .future: JournalCopy.future
        case .noEntry: JournalCopy.noEntry
        }
    }

    /// Whether the text is a placeholder (drawn italic and muted).
    var isPlaceholder: Bool {
        if case .entry = self { return false }
        return true
    }
}

/// One Month row, ready to draw.
struct JournalMonthRowModel: Equatable, Identifiable {
    let date: String
    let day: Int
    /// 0 = Sunday.
    let weekday: Int
    let level: UInt8
    let isToday: Bool
    let isFuture: Bool
    let state: JournalMonthRowState

    var id: String { date }

    init(_ record: JournalMonthDayRecord) {
        date = record.date
        day = JournalDates.day(record.date)
        weekday = Int(journalWeekday(date: record.date) ?? 0)
        level = record.hasEntry ? record.level : 0
        isToday = record.isToday
        isFuture = record.isFuture
        state = JournalMonthRowState(record)
    }

    /// Desktop dims a future row (60 %) and an empty past row (50 %).
    var opacity: Double {
        switch state {
        case .entry, .notPulled: 1
        case .future: isToday ? 1 : 0.6
        case .noEntry: isToday ? 1 : 0.5
        }
    }

    /// "Thursday 24, entry, Slept well…" (JP057).
    var accessibilityLabel: String {
        let status = switch state {
        case let .entry(preview): "\(JournalCopy.entryAccessibility), \(preview)"
        default: state.text
        }
        return JournalCopy.monthRowAccessibility(
            weekday: JournalCopy.weekdayName(weekday),
            day: day,
            status: status
        )
    }
}

/// The line under the Month title: "2026 · 17 entries · 6-day streak". The
/// streak part is drawn in the tint (Paper J05), so it is kept apart.
struct JournalMonthSubtitle: Equatable {
    let lead: String
    /// `nil` when no streak is running.
    let streak: String?

    init(year: Int, entryCount: Int, streak current: Int) {
        lead = [String(year), JournalCopy.entries(entryCount)].joined(separator: JournalCopy.subtitleSeparator)
        streak = current > 0 ? JournalCopy.streak(current) : nil
    }

    init(_ record: JournalMonthRecord) {
        self.init(year: Int(record.year), entryCount: Int(record.entryCount), streak: Int(record.streak.current))
    }

    var text: String {
        [lead, streak].compactMap(\.self).joined(separator: JournalCopy.subtitleSeparator)
    }
}

/// ‹ › on the Month screen.
enum JournalMonthStep {
    /// The month `offset` months from `year`/`month` (1-12), across years.
    static func shifted(year: Int, month: Int, by offset: Int) -> (year: Int, month: Int) {
        let index = year * 12 + (month - 1) + offset
        let month = ((index % 12) + 12) % 12
        return ((index - month) / 12, month + 1)
    }
}
