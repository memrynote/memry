import MemryCore
import SwiftUI

extension EnvironmentValues {
    /// Whether a note title exists in this vault (`nil`: not known yet).
    @Entry var noteTitleExists: ((String) -> Bool)?
    /// Review marks to draw over the body text.
    @Entry var reviewMarks: [ReviewComment] = []
    /// Each task block's task, by task id.
    @Entry var taskCards: [String: TaskCard] = [:]
}

/// Review marks drawn over the text they cover, as desktop draws them.
///
/// **Found by text, not by offset.** A mark's offsets are byte offsets into
/// the markdown desktop writes, and this client never holds that markdown
/// (§12.1), so there is nothing to count them against. What a mark does carry
/// is the text it covers, and a mark whose text occurs exactly once in the
/// note can only mean that occurrence. A mark whose text repeats is left to
/// the Review list under the body rather than drawn over a guess:
/// highlighting the wrong sentence is worse than not highlighting at all.
///
/// **The text a mark carries can be markdown.** Desktop stores a comment's
/// `visibleText` as the markdown it covers, markers and all (`start **bold`),
/// so its write-back can find it in the file, and a mark parsed from a file
/// always held markdown. An older desktop stored the words its editor showed
/// (`start bold`). `resolved` turns either into the words this note shows.
enum ReviewMarkStyle {
    /// Each mark with `visibleText` as `text` shows it. A mark whose own text
    /// `text` holds keeps it, so a mark that matched before matches as before;
    /// any other is read through `shownText`. A substitution's `originalText`
    /// is not in the note, so it is always read through `shownText`.
    static func resolved(_ marks: [ReviewComment], in text: String) -> [ReviewComment] {
        marks.map { mark in
            var shown = mark
            if text.range(of: mark.visibleText) == nil {
                shown.visibleText = shownText(mark.visibleText)
            }
            shown.originalText = mark.originalText.map(shownText)
            return shown
        }
    }

    /// The words markdown `visibleText` shows as: markers hidden, a link or
    /// a wiki link as its label, a code span as its code, an escape as its
    /// character, an image as nothing (the body draws a picture, no words),
    /// and the underline and colour tags desktop writes as HTML dropped.
    ///
    /// A mark is a slice of the markdown, so a marker can lose its partner
    /// (`start **bold`) and a link can be cut (`see [do`, `cs](https://x) now`).
    /// Those are read the way desktop's offset map hides them
    /// (`critic-markup-offset-map.ts`). A run of `*`, `_` or `~` with space
    /// on both sides, `_` inside a word and a single `~` are text, as
    /// CommonMark reads them.
    static func shownText(_ visibleText: String) -> String {
        shown(Array(visibleText))
    }

    private static func shown(_ text: [Character]) -> String {
        var out = ""
        var index = 0
        while index < text.count {
            let char = text[index]
            let next = index + 1 < text.count ? text[index + 1] : nil
            if char == "\\", let next, next.isASCII, next.isPunctuation || next.isSymbol {
                out.append(next)
                index += 2
            } else if char == "`" {
                let open = runLength(text, at: index)
                // An unclosed run is a code span the mark cuts: hidden.
                if let close = closingRun(text, from: index + open, length: open) {
                    out += String(text[(index + open) ..< close])
                    index = close + open
                } else {
                    index += open
                }
            } else if char == "<", let end = styleTagEnd(text, at: index) {
                index = end
            } else if let link = link(text, at: index) {
                out += link.shown
                index = link.end
            } else if "*_~".contains(char) {
                let length = runLength(text, at: index)
                let before = index > 0 ? text[index - 1] : nil
                let after = index + length < text.count ? text[index + length] : nil
                if !isMarker(char, length: length, before: before, after: after) {
                    out += String(repeating: char, count: length)
                }
                index += length
            } else {
                out.append(char)
                index += 1
            }
        }
        return out
    }

    /// A link or a wiki link at `start`, whole or cut by the mark's edge: the
    /// words it shows and where it ends. `nil` when none starts there.
    private static func link(_ text: [Character], at start: Int) -> (shown: String, end: Int)? {
        let next = start + 1 < text.count ? text[start + 1] : nil
        switch (text[start], next) {
        case ("[", "["):
            // `[[target|alias]]` shows its alias, `[[target]]` its target,
            // also when the mark ends inside it.
            let close = (start + 2 ..< max(start + 2, text.count - 1))
                .first { text[$0] == "]" && text[$0 + 1] == "]" } ?? text.count
            let inner = text[(start + 2) ..< close]
            return (String(inner.firstIndex(of: "|").map { inner[($0 + 1)...] } ?? inner), min(close + 2, text.count))
        case ("]", "]"):
            // The end of a wiki link the mark starts inside.
            return ("", start + 2)
        case ("!", "["):
            // An image: the body draws a picture, not words.
            return markdownLink(text, at: start + 1).map { ("", $0.end) }
        case ("[", _):
            if let link = markdownLink(text, at: start) {
                return (shown(Array(text[link.label])), link.end)
            }
            // A link the mark ends inside (`see [do`).
            return text[(start + 1)...].contains("]") ? nil : ("", start + 1)
        case ("]", "("):
            // The end of a link the mark starts inside (`cs](https://x)`).
            return text[(start + 2)...].firstIndex(of: ")").map { ("", $0 + 1) }
        default:
            return nil
        }
    }

    /// `[label](destination)` at `start`, read as desktop's `readMarkdownLink`.
    private static func markdownLink(_ text: [Character], at start: Int) -> (label: Range<Int>, end: Int)? {
        guard let close = text[(start + 1)...].firstIndex(of: "]"), close + 1 < text.count,
              text[close + 1] == "(", let end = text[(close + 2)...].firstIndex(of: ")")
        else { return nil }
        return (start + 1 ..< close, end + 1)
    }

    /// Where the underline or colour tag at `start` ends: `<span style="…">`
    /// and `</span>`, which desktop writes (`inline-colors.ts`), and `<u>` and
    /// `</u>`. `nil` for any other `<`, which is text (`a < b`).
    private static func styleTagEnd(_ text: [Character], at start: Int) -> Int? {
        guard let close = text[start...].firstIndex(of: ">") else { return nil }
        let tag = String(text[start ... close])
        let isStyle = ["<span>", "</span>", "<u>", "</u>"].contains(tag) || tag.hasPrefix("<span ")
        return isStyle ? close + 1 : nil
    }

    private static func runLength(_ text: [Character], at start: Int) -> Int {
        text[start...].prefix { $0 == text[start] }.count
    }

    /// Where a run of exactly `length` backticks starts, at or after `start`.
    private static func closingRun(_ text: [Character], from start: Int, length: Int) -> Int? {
        var index = start
        while index < text.count {
            guard text[index] == "`" else {
                index += 1
                continue
            }
            let run = runLength(text, at: index)
            if run == length { return index }
            index += run
        }
        return nil
    }

    private static func isMarker(_ char: Character, length: Int, before: Character?, after: Character?) -> Bool {
        let spaced = { (side: Character?) in side?.isWhitespace ?? true }
        let wordy = { (side: Character?) in side.map { $0.isLetter || $0.isNumber } ?? false }
        if spaced(before) && spaced(after) { return false }
        switch char {
        case "_": return !(wordy(before) && wordy(after))
        case "~": return length >= 2
        default: return true
        }
    }

    /// The marks whose covered text occurs exactly once in `text`, given as
    /// `resolved` returns them.
    static func unambiguous(_ marks: [ReviewComment], in text: String) -> [ReviewComment] {
        marks.filter { mark in
            let needle = mark.visibleText
            guard !needle.isEmpty, let first = text.range(of: needle) else { return false }
            return text.range(of: needle, range: first.upperBound..<text.endIndex) == nil
        }
    }

    static func apply(_ marks: [ReviewComment], to text: AttributedString) -> AttributedString {
        guard !marks.isEmpty else { return text }
        var out = text
        for mark in marks {
            guard let range = out.range(of: mark.visibleText) else { continue }
            switch mark.kind {
            case .comment, .substitution:
                out[range].backgroundColor = (Tokens.Content.fill(named: "orange")
                    ?? Tokens.Canvas.surface).color
                out[range].underlineStyle = .single
            case .addition:
                out[range].backgroundColor = (Tokens.Content.fill(named: "blue")
                    ?? Tokens.Canvas.surface).color
                out[range].foregroundColor = (Tokens.Content.ink(named: "blue")
                    ?? Tokens.Text.primary).color
            case .deletion:
                out[range].backgroundColor = (Tokens.Content.fill(named: "red")
                    ?? Tokens.Canvas.surface).color
                out[range].foregroundColor = (Tokens.Content.ink(named: "red")
                    ?? Tokens.Text.primary).color
                out[range].strikethroughStyle = .single
            }
        }
        return out
    }
}
