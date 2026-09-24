import Foundation
import MemryCore

// TP042. Which quick-add run the caret is finishing, and what to offer for it.
//
// The grammar is the core's (D1, D5): whether `@tomo` completes to
// `@Tomorrow`, whether `today 2p` is a time mid-entry and what `@may 17 3pm`
// resolves to all come from `predictTaskDate`, `isTaskTimeInProgress`,
// `parseTaskDate` and `predictTaskRepeat`. What stays here is the caret
// context the core cannot see: which trigger the end of the text sits in,
// desktop's renderer-side `detectTrigger` (`capture-bar-tokens.tsx`), and the
// splice that swaps a trigger for its completion. Offsets are UTF-16, as the
// core's spans are.

/// The quick-add run the caret sits at the end of.
struct QuickAddTrigger: Equatable, Sendable {
    enum Kind: String, Sendable {
        case datePhrase, priority, project, tag, noteLink, `repeat`
    }

    let kind: Kind
    /// What follows the trigger character (`repeat` keeps "every").
    let query: String
    /// UTF-16 offset where the trigger starts.
    let start: Int

    /// `detectTrigger`: an unclosed `[[` owns the rest of the text; a sigil
    /// (`!`, `+`, `#`) is the last token; `@` and `every` run over several
    /// words on the caret's line and the nearer one wins.
    static func detect(_ value: String) -> QuickAddTrigger? {
        let text = value as NSString
        let link = text.range(of: "[[", options: .backwards)
        if link.location != NSNotFound {
            let after = text.substring(from: link.location + link.length)
            if !after.contains("]]") {
                return QuickAddTrigger(kind: .noteLink, query: after, start: link.location)
            }
        }

        let token = String(value.reversed().prefix { !$0.isWhitespace }.reversed())
        let tokenStart = text.length - (token as NSString).length
        let sigils: [Character: Kind] = ["!": .priority, "+": .project, "#": .tag]
        if let first = token.first, let kind = sigils[first] {
            return QuickAddTrigger(kind: kind, query: String(token.dropFirst()), start: tokenStart)
        }

        let newline = text.range(of: "\n", options: .backwards)
        let lineStart = newline.location == NSNotFound ? 0 : newline.location + 1
        let atStart = atTrigger(in: text, from: lineStart)
        let everyStart = everyTrigger(in: text, from: lineStart)
        guard atStart != nil || everyStart != nil else { return nil }
        if let atStart, atStart > (everyStart ?? -1) {
            return QuickAddTrigger(kind: .datePhrase, query: text.substring(from: atStart + 1), start: atStart)
        }
        guard let everyStart else { return nil }
        return QuickAddTrigger(kind: .repeat, query: text.substring(from: everyStart), start: everyStart)
    }

    /// The last `@` on the line that starts a word.
    private static func atTrigger(in text: NSString, from lineStart: Int) -> Int? {
        let line = NSRange(location: lineStart, length: text.length - lineStart)
        let found = text.range(of: "@", options: .backwards, range: line)
        guard found.location != NSNotFound else { return nil }
        if found.location == lineStart { return found.location }
        let before = text.substring(with: NSRange(location: found.location - 1, length: 1))
        return before.allSatisfy(\.isWhitespace) ? found.location : nil
    }

    /// The last whole word "every" on the line (`/\bevery\b/gi`).
    private static func everyTrigger(in text: NSString, from lineStart: Int) -> Int? {
        let line = NSRange(location: lineStart, length: text.length - lineStart)
        guard let regex = try? NSRegularExpression(pattern: "\\bevery\\b", options: .caseInsensitive) else {
            return nil
        }
        return regex.matches(in: text as String, range: line).last?.range.location
    }

    /// `replaceTrigger`: the text up to the trigger, the completion, a space.
    static func replace(_ value: String, start: Int, with replacement: String) -> String {
        let text = value as NSString
        return text.substring(to: min(start, text.length)) + replacement + " "
    }
}

/// The inline completion for the trigger at the caret.
struct QuickAddGhost: Equatable, Sendable {
    /// UTF-16 offset the completion replaces from.
    let start: Int
    /// The whole trigger in canonical casing, e.g. `@Tomorrow`.
    let text: String
    /// The part not yet typed, drawn after the caret.
    let remainder: String

    /// A date or repeat completion from the core, or `nil` when there is
    /// nothing to finish. The completion always extends what was typed
    /// (case-insensitively), so accepting it never loses characters.
    static func predict(_ value: String, trigger: QuickAddTrigger?, now: String) -> QuickAddGhost? {
        guard let trigger else { return nil }
        let completion: String? = switch trigger.kind {
        case .datePhrase: predictTaskDate(query: trigger.query, now: now).map { "@\($0)" }
        case .repeat: predictTaskRepeat(query: trigger.query)
        case .priority, .project, .tag, .noteLink: nil
        }
        guard let completion else { return nil }
        let typed = (value as NSString).substring(from: min(trigger.start, (value as NSString).length))
        let typedLength = (typed as NSString).length
        let full = completion as NSString
        guard full.length > typedLength,
              full.substring(to: typedLength).lowercased() == typed.lowercased() else { return nil }
        return QuickAddGhost(start: trigger.start, text: completion, remainder: full.substring(from: typedLength))
    }

    /// The value with the completion accepted, caret past a space.
    func accept(in value: String) -> String {
        QuickAddTrigger.replace(value, start: start, with: text)
    }
}

/// What an `@` phrase resolves to right now, for the live hint under the
/// field (desktop's date-mention highlight rule, `date-mention-ghost.ts`).
enum QuickAddDateHint {
    /// The resolved date for the `@` phrase at the caret. While a time is
    /// still being typed ("today at", "today 2p") the last resolution stays,
    /// so the hint does not flicker away mid-entry.
    static func resolve(trigger: QuickAddTrigger?, now: String, previous: ParsedDate?) -> ParsedDate? {
        guard let trigger, trigger.kind == .datePhrase else { return nil }
        if let parsed = parseTaskDate(input: trigger.query, now: now) { return parsed }
        return isTaskTimeInProgress(query: trigger.query, now: now) ? previous : nil
    }
}
