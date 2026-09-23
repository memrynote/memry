import Foundation
import MemryCore

/// The words an inline node shows when it carries no text of its own.
///
/// `wikiLink`, `linkMention`, `dateMention` and `hashTag` are atoms in
/// BlockNote's schema (`content: "none"`): the document holds their
/// attributes and no characters, so the core hands each one over as an
/// **empty** run carrying the node's attributes in `markAttrs`. Drawing the
/// run's text drew nothing, and a sentence like "see [[Dune]]" read "see ".
/// Desktop derives each label from the attributes at render time; this does
/// the same, from the same attributes.
enum NoteInlineLabel {
    /// The run's own text when it has any, otherwise the label its node
    /// derives from its attributes. An empty result means there is genuinely
    /// nothing to show, which is true of an inline image or a checkbox.
    static func text(of run: InlineRun, now: Date = .now) -> String {
        guard run.text.isEmpty else { return run.text }
        if run.marks.contains("wikiLink") { return wikiLink(run) }
        if run.marks.contains("linkMention") { return linkMention(run) }
        if run.marks.contains("dateMention") { return dateMention(run, now: now) }
        if run.marks.contains("hashTag") {
            let tag = nonEmpty(run.markAttrs["hashTag.tag"]) ?? nonEmpty(run.target)
            return tag.map { "#\($0)" } ?? ""
        }
        return ""
    }

    /// The alias when the author gave one, otherwise the title it points at.
    private static func wikiLink(_ run: InlineRun) -> String {
        nonEmpty(run.markAttrs["wikiLink.alias"])
            ?? nonEmpty(run.markAttrs["wikiLink.target"])
            ?? nonEmpty(run.target)
            ?? ""
    }

    /// The page's own name when the mention carries one, then its site, then
    /// its domain, then the address itself — the most readable name that is
    /// actually stored, never a fetched one.
    private static func linkMention(_ run: InlineRun) -> String {
        nonEmpty(run.markAttrs["linkMention.title"])
            ?? nonEmpty(run.markAttrs["linkMention.siteName"])
            ?? nonEmpty(run.markAttrs["linkMention.domain"])
            ?? nonEmpty(run.markAttrs["linkMention.url"])
            ?? nonEmpty(run.target)
            ?? ""
    }

    /// Desktop's pill label (`packages/editor-web/src/date-mentions.ts`
    /// `dateMentionLabel`): a relative day or an absolute date, then the time
    /// when the mention carries one.
    static func dateMention(
        _ run: InlineRun,
        now: Date,
        calendar: Calendar = desktopCalendar
    ) -> String {
        guard
            let iso = nonEmpty(run.markAttrs["dateMention.dateISO"]) ?? nonEmpty(run.target),
            let date = parseISO(iso)
        else { return "Date" }

        let label = run.markAttrs["dateMention.dateFormat"] == "full"
            ? absoluteDate(date, calendar: calendar)
            : relativeDay(date, now: now, calendar: calendar)

        guard run.markAttrs["dateMention.hasTime"] == "true" else { return label }
        var time = Date.FormatStyle.dateTime.hour().minute()
        time.timeZone = calendar.timeZone
        return "\(label) \(date.formatted(time))"
    }

    /// Monday-first, which is the week start desktop ships by default
    /// (`calendar.weekStartDay`). The phone has no route to the desktop
    /// setting, and a week that begins on a different day moves a date
    /// between "This Friday" and "Next Friday".
    static var desktopCalendar: Calendar {
        var calendar = Calendar.current
        calendar.firstWeekday = 2
        return calendar
    }

    private static func absoluteDate(_ date: Date, calendar: Calendar) -> String {
        var month = Date.FormatStyle().month(.abbreviated)
        month.timeZone = calendar.timeZone
        let day = calendar.component(.day, from: date)
        let year = calendar.component(.year, from: date)
        return "\(day) \(date.formatted(month)), \(year)"
    }

    private static func relativeDay(_ date: Date, now: Date, calendar: Calendar) -> String {
        let start = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: today, to: start).day ?? 0
        switch days {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        default: break
        }

        var weekdayStyle = Date.FormatStyle().weekday(.wide)
        weekdayStyle.timeZone = calendar.timeZone
        let weekday = date.formatted(weekdayStyle)
        guard
            let week = calendar.dateInterval(of: .weekOfYear, for: date)?.start,
            let thisWeek = calendar.dateInterval(of: .weekOfYear, for: now)?.start
        else { return absoluteDate(date, calendar: calendar) }

        if week == thisWeek { return days >= 2 ? "This \(weekday)" : weekday }
        if week == calendar.date(byAdding: .day, value: 7, to: thisWeek) {
            return "Next \(weekday)"
        }
        if week == calendar.date(byAdding: .day, value: -7, to: thisWeek) {
            return "Last \(weekday)"
        }
        return absoluteDate(date, calendar: calendar)
    }

    private static func parseISO(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) { return date }
        let day = ISO8601DateFormatter()
        day.formatOptions = [.withFullDate]
        return day.date(from: value)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
