import Foundation
import Observation

// JP030, D3. "Today" for the journal is the device's **local calendar date**,
// supplied by the shell. The core never derives a day from an instant, so
// every journal read that needs today takes this clock's `today`.
//
// The clock follows the day rolling over at midnight and the phone changing
// time zone. In debug builds it honours `MEMRY_JOURNAL_TODAY=YYYY-MM-DD`
// (environment or launch argument), which pins "today" to an agent day for
// simulator runs (spec 005-journal §0.5). Release builds ignore it.

@MainActor
@Observable
final class JournalClock {
    /// Today's `YYYY-MM-DD` in the user's zone (or the debug pin).
    private(set) var today: String

    /// The instant source; tests inject one.
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let pinned: String?
    // `nonisolated(unsafe)`: written once on the main actor in `start`, read
    // only by `deinit`, which runs after the last reference is gone.
    @ObservationIgnored private nonisolated(unsafe) var observers: [NSObjectProtocol] = []
    @ObservationIgnored private nonisolated(unsafe) var center: NotificationCenter?

    init(now: @escaping @Sendable () -> Date = { Date() }, pinned: String? = JournalClock.debugPin()) {
        self.now = now
        self.pinned = pinned
        today = pinned ?? JournalDates.key(now())
    }

    /// Starts following midnight and time-zone changes. Idempotent.
    func start(center: NotificationCenter = .default) {
        guard observers.isEmpty else { return }
        self.center = center
        let names: [Notification.Name] = [
            .NSCalendarDayChanged,
            .NSSystemTimeZoneDidChange,
            .NSSystemClockDidChange
        ]
        observers = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
    }

    deinit {
        // A vault reopen builds a new clock; the old one's tokens go with it.
        for observer in observers { center?.removeObserver(observer) }
    }

    /// Re-reads today (also called when the app returns to the foreground).
    func refresh() {
        let next = pinned ?? JournalDates.key(now())
        if next != today { today = next }
    }

    /// The instant now, for reminder times and template `{{time}}`.
    func instant() -> Date { now() }

    /// `MEMRY_JOURNAL_TODAY` in debug builds; always `nil` in release.
    nonisolated static func debugPin(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> String? {
        #if DEBUG
            let raw = environment["MEMRY_JOURNAL_TODAY"] ?? defaults.string(forKey: "MEMRY_JOURNAL_TODAY")
            guard let raw, JournalDates.date(raw) != nil, raw.count == 10 else { return nil }
            return raw
        #else
            return nil
        #endif
    }
}

/// Calendar-date conversions every journal screen shares. Dates are local
/// calendar keys (`YYYY-MM-DD`); arithmetic runs on the Gregorian calendar in
/// the current zone, so no instant ever decides a day.
enum JournalDates {
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter
    }

    /// `YYYY-MM-DD` of an instant in the user's zone.
    static func key(_ date: Date) -> String {
        formatter("yyyy-MM-dd").string(from: date)
    }

    /// Local midnight of a `YYYY-MM-DD` key, or `nil` for a key that is not a day.
    static func date(_ key: String) -> Date? {
        guard key.count == 10, let date = formatter("yyyy-MM-dd").date(from: key) else { return nil }
        return Self.key(date) == key ? date : nil
    }

    /// `key` moved by `days` calendar days.
    static func adding(_ days: Int, to key: String) -> String {
        guard let date = date(key), let moved = calendar.date(byAdding: .day, value: days, to: date) else {
            return key
        }
        return Self.key(moved)
    }

    /// Whole calendar days from `from` to `to` (positive when `to` is later).
    static func days(from: String, to: String) -> Int {
        guard let start = date(from), let end = date(to) else { return 0 }
        return calendar.dateComponents([.day], from: start, to: end).day ?? 0
    }

    /// Year and month (1-12) of a key.
    static func yearMonth(_ key: String) -> (year: Int, month: Int) {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return (1970, 1) }
        return (parts[0], parts[1])
    }

    /// Day of month of a key.
    static func day(_ key: String) -> Int {
        Int(key.suffix(2)) ?? 1
    }

    /// `YYYY-MM-DD` of the first day of a month.
    static func firstOfMonth(year: Int, month: Int) -> String {
        String(format: "%04d-%02d-01", year, month)
    }
}
