//
//  WikiTarget.swift
//  Reading a wiki-link target's text for presentation: its note and heading
//  halves, and the path key a path-form link names.
//
//  Desktop reference: `packages/shared/src/wiki-target.ts`. Resolution itself
//  is the core's (`Notes.resolveWikiTarget`); this only draws.
//

import Foundation
import MemryCore

enum WikiTarget {
    /// Desktop's `wikiLinkTargets` pattern, `[[target]]` or `[[target|alias]]`.
    private static let literalPattern = try? NSRegularExpression(pattern: #"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"#)

    /// Each `[[...]]` typed as text in `text`: the range it covers, brackets
    /// included, and its target. Synced bodies often hold the characters
    /// rather than a `wikiLink` node (#3318); the core indexes both, and this
    /// finds the characters for drawing and tapping. A table cell's escaped
    /// alias pipe `\|` leaves its backslash out of the target, as the core's
    /// scan does.
    static func literals(in text: String) -> [(range: NSRange, target: String)] {
        guard let literalPattern, text.contains("[[") else { return [] }
        let string = text as NSString
        return literalPattern.matches(in: text, range: NSRange(location: 0, length: string.length)).map { match in
            var target = string.substring(with: match.range(at: 1))
            if target.hasSuffix("\\"), NSMaxRange(match.range(at: 1)) < NSMaxRange(match.range) - 2 {
                target.removeLast()
            }
            return (match.range, target)
        }
    }

    /// `Note#Heading` → (`Note`, `Heading`), desktop's `splitWikiTarget`. The
    /// last `#` segment is the heading; `nil` when the target has no `#`.
    static func split(_ target: String) -> (note: String, heading: String?) {
        let raw = target.trimmingCharacters(in: .whitespaces)
        guard let hash = raw.firstIndex(of: "#") else { return (raw, nil) }
        let heading = raw[raw.index(after: hash)...].split(separator: "#", omittingEmptySubsequences: false).last ?? ""
        return (
            raw[..<hash].trimmingCharacters(in: .whitespaces),
            heading.trimmingCharacters(in: .whitespaces)
        )
    }

    /// The case-folded vault path a path-form note half names (`Work/Plan`,
    /// `/Plan`, `Work/Plan.md`), or `nil` for a plain title.
    static func pathKey(_ noteHalf: String) -> String? {
        var half = noteHalf.trimmingCharacters(in: .whitespaces).lowercased()
        guard half.contains("/") else { return nil }
        if half.hasPrefix("/") { half.removeFirst() }
        if half.hasSuffix(".md") { half.removeLast(3) }
        return half
    }

    /// The case-folded path key of a note, as ``pathKey(_:)`` reads a link to it.
    static func pathKey(of note: NoteSummary) -> String {
        let folder = note.folderPath?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        return (folder.isEmpty ? note.title : "\(folder)/\(note.title)").lowercased()
    }

    /// Whether a link's target names one of the vault's notes by title or by
    /// path, split half first and then the raw string, as the resolver reads
    /// it. `titles` and `paths` are case-folded.
    static func names(_ target: String, titles: Set<String>, paths: Set<String>) -> Bool {
        func known(_ half: String) -> Bool {
            if let path = pathKey(half) { return paths.contains(path) }
            return titles.contains(half.lowercased())
        }
        let (note, heading) = split(target)
        if heading != nil, !note.isEmpty, known(note) { return true }
        return known(target.trimmingCharacters(in: .whitespaces))
    }

    /// The first block that is a heading reading `heading`, trimmed and
    /// case-folded as desktop's `normalizeHeading` compares them.
    static func headingIndex(_ heading: String, in blocks: [Block]) -> Int? {
        let wanted = heading.trimmingCharacters(in: .whitespaces).lowercased()
        guard !wanted.isEmpty else { return nil }
        return blocks.firstIndex { block in
            block.kind == "heading"
                && block.inline.map(\.text).joined().trimmingCharacters(in: .whitespaces).lowercased() == wanted
        }
    }
}
