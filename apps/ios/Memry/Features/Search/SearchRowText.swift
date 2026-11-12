import Foundation
import MemryCore

/// What a search hit row says (#4323), after desktop's `search-result-item`:
/// a note's emoji and title over its folder, a journal's relative day over
/// "Journal", a task's title. The snippet line follows in the view.
struct SearchRowText: Equatable {
    enum Caption: Equatable {
        /// The full vault folder; the view truncates it at the head.
        case folder(String)
        case journal
    }

    let title: String
    let caption: Caption?
    let accessibilityLabel: String

    init(hit: SearchResult, now: Date = .now, calendar: Calendar = .autoupdatingCurrent,
         locale: Locale = .autoupdatingCurrent) {
        let snippet = hit.snippet.map(\.text).joined()
        switch hit.kind {
        case "journal":
            let date = hit.journalDate.flatMap { $0.isEmpty ? nil : $0 }
            title = date.map { SearchDayLabel.text($0, now: now, calendar: calendar, locale: locale) } ?? hit.title
            caption = .journal
            let spoken = date.map { SearchDayLabel.spoken($0, now: now, calendar: calendar, locale: locale) } ?? hit.title
            accessibilityLabel = Self.joined(["Journal", spoken, snippet])
        case "task":
            title = hit.title.isEmpty ? TasksCopy.untitledTask : hit.title
            caption = nil
            accessibilityLabel = Self.joined([title, snippet])
        default:
            let name = hit.title.isEmpty ? "Untitled note" : hit.title
            let emoji = ProjectIconValue.emoji(hit.emoji)
            let folder = hit.folderPath.map(SearchFolderPath.segments).flatMap { $0.isEmpty ? nil : $0.joined(separator: "/") }
            title = emoji.map { "\($0) \(name)" } ?? name
            caption = folder.map(Caption.folder)
            accessibilityLabel = Self.joined([emoji ?? "", name, folder.map { "Folder \($0)" } ?? "", snippet])
        }
    }

    private static func joined(_ parts: [String]) -> String {
        parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// A folder path cut at the head on segment boundaries: `A/B/C` offers itself,
/// then `…/B/C`, then `…/C`, and the row shows the first that fits.
enum SearchFolderPath {
    static func segments(_ path: String) -> [String] {
        path.split(separator: "/").map(String.init)
    }

    static func candidates(_ path: String) -> [String] {
        let parts = segments(path)
        return parts.indices.map { start in
            let tail = parts[start...].joined(separator: "/")
            return start == 0 ? tail : "…/\(tail)"
        }
    }
}

/// Desktop's `dayLabel` (`search-format.ts`) in the user's locale and
/// calendar: "Today", "Yesterday" or "Tomorrow", a weekday in the current
/// week, else "Jul 21", with the year when it is not this year's.
enum SearchDayLabel {
    static func text(_ isoDay: String, now: Date, calendar: Calendar, locale: Locale) -> String {
        guard let day = date(isoDay, calendar: calendar) else { return isoDay }
        if let relative = relative(day, now: now, calendar: calendar, locale: locale) { return relative }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.isDate(day, equalTo: now, toGranularity: .weekOfYear) {
            return day.formatted(style.weekday(.abbreviated))
        }
        let monthDay = style.month(.abbreviated).day()
        return day.formatted(calendar.isDate(day, equalTo: now, toGranularity: .year) ? monthDay : monthDay.year())
    }

    /// The same day for VoiceOver: the relative word, else the full date.
    static func spoken(_ isoDay: String, now: Date, calendar: Calendar, locale: Locale) -> String {
        guard let day = date(isoDay, calendar: calendar) else { return isoDay }
        if let relative = relative(day, now: now, calendar: calendar, locale: locale) { return relative }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .weekday(.wide).month(.wide).day()
        return day.formatted(calendar.isDate(day, equalTo: now, toGranularity: .year) ? style : style.year())
    }

    private static func relative(_ day: Date, now: Date, calendar: Calendar, locale: Locale) -> String? {
        guard let offset = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: day)
        ).day, (-1...1).contains(offset) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.dateTimeStyle = .named
        let word = formatter.localizedString(from: DateComponents(day: offset))
        return word.prefix(1).uppercased(with: locale) + word.dropFirst()
    }

    /// Local midnight of a Gregorian `YYYY-MM-DD` in the calendar's zone.
    private static func date(_ isoDay: String, calendar: Calendar) -> Date? {
        let parts = isoDay.split(separator: "-").compactMap { Int($0) }
        guard isoDay.count == 10, parts.count == 3 else { return nil }
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard components.isValidDate(in: gregorian) else { return nil }
        return gregorian.date(from: components)
    }
}
