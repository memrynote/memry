//
//  InlineSuggestions.swift
//  The `[[` and `@` menus: when they are open, what they offer, and the
//  attributes the node they insert carries.
//
//  Desktop references: `use-wiki-link-suggestions.ts`, `use-mention-suggestions.ts`,
//  `date-suggestions.ts`, `packages/editor-schema/src/inline/{wiki-link,date-mention}.ts`.
//

import Foundation
import MemryCore

/// A wiki link's props, as desktop's `createWikiLinkInlineContent` writes them.
enum WikiLinkAttrs {
    /// `alias` is empty when the link shows its target, and an alias equal to
    /// the target is no alias (`wikiLinkToText`).
    static func attrs(target: String, alias: String?) -> [String: String] {
        let alias = alias?.trimmingCharacters(in: .whitespaces) ?? ""
        return ["target": target, "alias": alias == target ? "" : alias]
    }
}

/// A date mention's value, desktop's `DateMentionValue`.
struct DateMentionValue: Equatable, Sendable {
    /// The instant, spelled as JavaScript's `toISOString` spells it.
    var dateISO: String
    var hasTime: Bool
    var dateFormat = "relative"
    /// `none`, or `at` for "Remind me".
    var remind = "none"
    var timeFormat = "system"

    func attrs(anchorId: String) -> [String: String] {
        [
            "anchorId": anchorId,
            "dateISO": dateISO,
            "hasTime": hasTime ? "true" : "false",
            "dateFormat": dateFormat,
            "remind": remind,
            "timeFormat": timeFormat,
        ]
    }

    /// Desktop's `dm_<uuid>` anchor (`insertDatePill`).
    static func mintAnchorId() -> String { "dm_" + UUID().uuidString.lowercased() }

    /// `Date.prototype.toISOString`: UTC, milliseconds, `Z`.
    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

/// An open `[[` or `@` menu: the text it will replace, and what is typed.
enum InlineTrigger: Equatable {
    /// `range` covers `[[query` and a closing `]]` right after the caret.
    case wiki(range: NSRange, query: String)
    /// `range` covers `@query`.
    case mention(range: NSRange, query: String)
    /// `range` covers `/query`: the slash menu.
    case slash(range: NSRange, query: String)

    var range: NSRange {
        switch self {
        case let .wiki(range, _), let .mention(range, _), let .slash(range, _): range
        }
    }

    /// The trigger the caret sits in, or `nil`.
    static func active(in text: String, caret: Int) -> InlineTrigger? {
        let string = text as NSString
        guard caret >= 0, caret <= string.length else { return nil }
        if let wiki = wiki(in: string, caret: caret) { return wiki }
        // The trigger nearer the caret is the one being typed.
        let candidates = [mention(in: string, caret: caret), slash(in: string, caret: caret)].compactMap { $0 }
        return candidates.max { $0.range.location < $1.range.location }
    }

    /// `/` at the start of the block or after whitespace, with a query that
    /// does not start with a space.
    private static func slash(in string: NSString, caret: Int) -> InlineTrigger? {
        var index = caret - 1
        while index >= 0, caret - index <= 40 {
            let character = string.character(at: index)
            if stops.contains(character) { return nil }
            if character == 47 { // "/"
                if index > 0 {
                    let before = string.character(at: index - 1)
                    guard before == 32 || before == 9 || before == 0xA0 else { return nil }
                }
                let query = string.substring(with: NSRange(location: index + 1, length: caret - index - 1))
                if let first = query.unicodeScalars.first, CharacterSet.whitespaces.contains(first) { return nil }
                return .slash(range: NSRange(location: index, length: caret - index), query: query)
            }
            index -= 1
        }
        return nil
    }

    private static let stops: Set<unichar> = [10, 0xFFFC]

    private static func wiki(in string: NSString, caret: Int) -> InlineTrigger? {
        var index = caret - 1
        while index >= 1 {
            let character = string.character(at: index)
            if stops.contains(character) { return nil }
            if character == 93, string.character(at: index - 1) == 93 { return nil } // "]]"
            if character == 91, string.character(at: index - 1) == 91 { // "[["
                let start = index - 1
                let query = string.substring(with: NSRange(location: index + 1, length: caret - index - 1))
                var length = caret - start
                if caret + 2 <= string.length,
                   string.substring(with: NSRange(location: caret, length: 2)) == "]]" {
                    length += 2
                }
                return .wiki(range: NSRange(location: start, length: length), query: query)
            }
            index -= 1
        }
        return nil
    }

    private static func mention(in string: NSString, caret: Int) -> InlineTrigger? {
        var index = caret - 1
        while index >= 0, caret - index <= 40 {
            let character = string.character(at: index)
            if stops.contains(character) { return nil }
            if character == 64 { // "@"
                if index > 0 {
                    let before = string.character(at: index - 1)
                    guard before == 32 || before == 9 || before == 0xA0 || before == 0xFFFC else { return nil }
                }
                let query = string.substring(with: NSRange(location: index + 1, length: caret - index - 1))
                return .mention(range: NSRange(location: index, length: caret - index), query: query)
            }
            index -= 1
        }
        return nil
    }
}

/// `[[target]]` and `[[target|alias]]` typed out in full: the text desktop's
/// input rule and collab promotion turn into a `wikiLink` node.
enum WikiLinkText {
    struct Match: Equatable {
        let range: NSRange
        let target: String
        let alias: String
    }

    // Desktop's `WIKI_LINK_FULL_PATTERN`, unanchored.
    private static let pattern = try? NSRegularExpression(pattern: "\\[\\[([^\\]|\\n\u{FFFC}]+)(?:\\|([^\\]\\n\u{FFFC}]+))?\\]\\]")

    static func matches(in text: String) -> [Match] {
        guard let pattern else { return [] }
        let string = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: string.length)).compactMap { result in
            let target = string.substring(with: result.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let aliasRange = result.range(at: 2)
            let alias = aliasRange.location == NSNotFound
                ? "" : string.substring(with: aliasRange).trimmingCharacters(in: .whitespaces)
            guard !target.isEmpty else { return nil }
            return Match(range: result.range, target: target, alias: alias)
        }
    }

    /// The matches in `text` that touch what changed since `base`: a link
    /// typed since the last commit. A link already in `base` was converted by
    /// that commit, or arrived as literal text, and desktop's input rule only
    /// fires on typing; converting it again would land its offsets on the
    /// text that follows it.
    static func typed(in text: String, since base: String) -> [Match] {
        let new = text as NSString
        let old = base as NSString
        guard !new.isEqual(to: base) else { return [] }
        let limit = min(new.length, old.length)
        var prefix = 0
        while prefix < limit, new.character(at: prefix) == old.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < limit - prefix,
              new.character(at: new.length - 1 - suffix) == old.character(at: old.length - 1 - suffix) {
            suffix += 1
        }
        let changed = NSRange(location: prefix, length: new.length - suffix - prefix)
        return matches(in: text).filter { match in
            // A pure deletion changed a point: it formed the link only from
            // strictly inside it.
            if changed.length == 0 {
                return match.range.location < changed.location && changed.location < NSMaxRange(match.range)
            }
            return match.range.location < NSMaxRange(changed) && changed.location < NSMaxRange(match.range)
        }
    }

    /// `search|alias`, desktop's `parseWikiLinkQuery` without headings.
    static func parseQuery(_ query: String) -> (search: String, alias: String) {
        let parts = query.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        let search = parts.first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        let alias = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
        return (search, alias)
    }
}

/// One row of the `[[` or `@` menu.
struct EditorSuggestion: Identifiable, Equatable {
    enum Kind: Equatable {
        /// A link to a note by title, with the alias typed after `|`.
        case note(title: String, alias: String)
        /// A link to a note that does not exist yet (desktop's `create` row).
        case create(title: String, alias: String)
        case date(DateMentionValue)
        /// A slash menu row.
        case slash(SlashMenuItem)
    }

    let id: String
    let title: String
    var subtitle: String?
    let symbol: String
    let kind: Kind
}

enum EditorSuggestions {
    static let limit = 10

    /// The `[[` menu (`getWikiLinkItems`): matching notes, then a create row
    /// when nothing matches exactly.
    static func wiki(query: String, titles: [String]) -> [EditorSuggestion] {
        let (search, alias) = WikiLinkText.parseQuery(query)
        let matched = rank(titles, search)
        if !alias.isEmpty, let exact = matched.first(where: { $0.caseInsensitiveCompare(search) == .orderedSame }) {
            return [EditorSuggestion(id: "alias:\(exact)", title: alias, subtitle: exact, symbol: "link", kind: .note(title: exact, alias: alias))]
        }
        var out = matched.prefix(limit).map {
            EditorSuggestion(id: "note:\($0)", title: $0.isEmpty ? "Untitled" : $0, symbol: "doc.text", kind: .note(title: $0, alias: alias))
        }
        if !search.isEmpty, !titles.contains(where: { $0.caseInsensitiveCompare(search) == .orderedSame }) {
            out.append(EditorSuggestion(id: "create:\(search)", title: "Create \u{201c}\(search)\u{201d}", symbol: "plus", kind: .create(title: search, alias: alias)))
        }
        return out
    }

    /// The `@` menu (`getMentionItems`): the date and "Remind me" rows when
    /// the query reads as a date (empty is today), "Now" for `@now`, then
    /// notes.
    static func mention(
        query: String, titles: [String], now: Date = .now, calendar: Calendar = .current
    ) -> [EditorSuggestion] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        var out: [EditorSuggestion] = []
        if isNowQuery(trimmed) {
            var minute = now
            minute = calendar.date(bySetting: .second, value: 0, of: minute) ?? minute
            let value = DateMentionValue(dateISO: DateMentionValue.iso(minute), hasTime: true)
            out.append(EditorSuggestion(id: "now", title: "Now", subtitle: label(value, now: now), symbol: "clock", kind: .date(value)))
        }
        if let parsed = parseDate(trimmed, now: now, calendar: calendar) {
            let date = DateMentionValue(dateISO: DateMentionValue.iso(parsed.date), hasTime: parsed.hasTime)
            out.append(EditorSuggestion(id: "date", title: label(date, now: now), symbol: "calendar", kind: .date(date)))
            // Desktop's reminder default: the parsed instant, or tomorrow at
            // 09:00 when that instant has passed.
            var remindAt = parsed.date
            var remindHasTime = parsed.hasTime
            if parsed.date <= now {
                let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
                remindAt = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
                remindHasTime = false
            }
            var remind = DateMentionValue(dateISO: DateMentionValue.iso(remindAt), hasTime: remindHasTime)
            remind.remind = "at"
            out.append(EditorSuggestion(
                id: "remind", title: "Remind me",
                subtitle: label(DateMentionValue(dateISO: remind.dateISO, hasTime: true), now: now),
                symbol: "alarm", kind: .date(remind)
            ))
        }
        out += rank(titles, trimmed).prefix(limit).map {
            EditorSuggestion(id: "note:\($0)", title: $0.isEmpty ? "Untitled" : $0, symbol: "doc.text", kind: .note(title: $0, alias: ""))
        }
        return out
    }

    static func isNowQuery(_ query: String) -> Bool {
        let lower = query.lowercased()
        return lower.count >= 2 && "now".hasPrefix(lower)
    }

    /// How a date value reads, through the same label the note draws.
    static func label(_ value: DateMentionValue, now: Date) -> String {
        let run = InlineRun(
            text: "", marks: ["dateMention"],
            markAttrs: ["dateMention.dateISO": value.dateISO, "dateMention.hasTime": value.hasTime ? "true" : "false"],
            target: nil
        )
        return NoteInlineLabel.dateMention(run, now: now)
    }

    /// Titles containing `search`, prefix matches first. Empty search lists
    /// every title in the order given (most recently modified first).
    static func rank(_ titles: [String], _ search: String) -> [String] {
        guard !search.isEmpty else { return titles }
        let prefixed = titles.filter { $0.lowercased().hasPrefix(search.lowercased()) }
        let contained = titles.filter {
            !$0.lowercased().hasPrefix(search.lowercased()) && $0.localizedCaseInsensitiveContains(search)
        }
        return prefixed + contained
    }

    // MARK: - Dates

    private static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

    /// A date the query names, at 09:00 when it names no time (desktop's
    /// `buildDateSuggestions` base). An empty query is today.
    static func parseDate(
        _ query: String, now: Date, calendar: Calendar = .current
    ) -> (date: Date, hasTime: Bool)? {
        let lower = query.lowercased().trimmingCharacters(in: .whitespaces)
        let today = calendar.startOfDay(for: now)
        func at9(_ day: Date) -> (Date, Bool) {
            (calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day, false)
        }
        func days(_ count: Int) -> Date { calendar.date(byAdding: .day, value: count, to: today) ?? today }

        switch lower {
        case "", "today": return at9(today)
        case "tomorrow", "tmr", "tmrw": return at9(days(1))
        case "yesterday": return at9(days(-1))
        case "next week": return at9(days(7))
        case "next month": return at9(calendar.date(byAdding: .month, value: 1, to: today) ?? today)
        default: break
        }
        let words = lower.split(separator: " ").map(String.init)
        let named = words.last.flatMap { word in weekdays.firstIndex { $0 == word || ($0.hasPrefix(word) && word.count >= 3) } }
        if let named, words.count == 1 || (words.count == 2 && words[0] == "next") {
            let current = calendar.component(.weekday, from: today) - 1
            var ahead = (named - current + 7) % 7
            if ahead == 0 { ahead = 7 }
            return at9(days(ahead))
        }
        if words.count == 3, words[0] == "in", let count = Int(words[1]) {
            let unit: Calendar.Component? = words[2].hasPrefix("day") ? .day
                : words[2].hasPrefix("week") ? .weekOfYear
                : words[2].hasPrefix("month") ? .month : nil
            if let unit, let day = calendar.date(byAdding: unit, value: count, to: today) { return at9(day) }
        }
        guard lower.rangeOfCharacter(from: .decimalDigits) != nil || lower.count > 3,
              let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue),
              let match = detector.firstMatch(in: query, range: NSRange(location: 0, length: (query as NSString).length)),
              match.range.length == (query as NSString).length,
              let date = match.date
        else { return nil }
        let hasTime = lower.range(of: "\\d{1,2}(:\\d{2})?\\s*(am|pm)|\\d{1,2}:\\d{2}", options: .regularExpression) != nil
        return hasTime ? (date, true) : at9(calendar.startOfDay(for: date))
    }
}
