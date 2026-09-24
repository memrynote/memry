import Foundation
import MemryCore

// TP044. What the date sheet shows, as values a test can assert. Every date
// here is the core's answer (`parseTaskDate`, `predictTaskDate`,
// `isTaskTimeInProgress`); Swift only names and formats it.

/// One quick date the sheet offers (`getQuickDateOptions`).
struct TaskDateSuggestion: Equatable, Identifiable, Sendable {
    enum Kind: String, CaseIterable, Sendable {
        case today, tomorrow, weekend, nextWeek

        /// The phrase the core resolves for this row.
        var phrase: String {
            switch self {
            case .today: "today"
            case .tomorrow: "tomorrow"
            case .weekend: "this weekend"
            case .nextWeek: "next week"
            }
        }
    }

    let kind: Kind
    /// `YYYY-MM-DD`.
    let date: String

    var id: String { kind.rawValue }
}

/// How the natural-language field reads what was typed.
enum TaskDateReading: Equatable, Sendable {
    /// Nothing typed.
    case empty
    /// A date, with the core's `displayText`.
    case resolved(ParsedDate)
    /// A time is still being typed after a date: no verdict yet.
    case typing
    /// Desktop's "Couldn't understand this date".
    case notUnderstood
}

/// `HH:MM` <-> the `Date` a time-only picker binds to.
enum TaskTimeText {
    private static func formatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "HH:mm"
        return formatter
    }

    static func date(_ time: String) -> Date? { formatter().date(from: time) }

    static func string(_ date: Date) -> String { formatter().string(from: date) }

    /// Desktop's due-date picker adds 9:00 AM.
    static let defaultTime = "09:00"
}
