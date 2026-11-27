//
//  HashTagSuggestions.swift
//  The `#` menu: when it is open, which vault tags it offers, and the props
//  the `hashTag` node it inserts carries.
//
//  Desktop references: `hash-tag-inline-plugin.ts` (the tag characters),
//  `tag-suggestion-popover.tsx` (the ranking), `use-tag-suggestions.ts` (the
//  colour), `packages/editor-schema/src/inline/hash-tag.ts` (the node).
//

import Foundation

/// `#tag` written as plain text: what desktop reads as a tag
/// (`hash-tag.tsx`, `HASH_TAG_PATTERN` and `extractInlineTags`) and turns
/// back into a chip when it opens the note. Desktop writes that chip; this
/// client does not write on read, so it only draws and opens it.
enum HashTagText {
    // A `#` at the start or after whitespace, then desktop's tag grammar
    // (`@memry/shared/inline-tags`): `/`-separated segments of a letter or digit
    // followed by letters, marks, digits, `_` or `-`, in any script.
    private static let pattern = try? NSRegularExpression(
        pattern: #"(?<!\S)#([\p{Alphabetic}\p{N}][\p{Alphabetic}\p{M}\p{N}_-]*(?:/[\p{Alphabetic}\p{N}][\p{Alphabetic}\p{M}\p{N}_-]*)*)"#
    )

    /// Each `#tag` in `text`: the range it covers, `#` included, and the
    /// tag's name. A tag holds a letter, so `#2024` is prose.
    static func matches(in text: String) -> [(range: NSRange, tag: String)] {
        guard let pattern, text.contains("#") else { return [] }
        let string = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: string.length)).compactMap {
            let tag = string.substring(with: $0.range(at: 1))
            return tag.unicodeScalars.contains(where: \.properties.isAlphabetic) ? ($0.range, tag) : nil
        }
    }
}

/// An open `#` menu: `range` covers `#query`.
struct HashTagTrigger: Equatable {
    let range: NSRange
    let query: String

    /// Desktop's `TAG_CHAR_PATTERN`: `[\p{Alphabetic}\p{M}\p{N}_\-/]`.
    static func isTagCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .nonspacingMark, .spacingMark, .enclosingMark, .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return scalar.properties.isAlphabetic || "_-/".unicodeScalars.contains(scalar)
        }
    }

    /// The `#query` the caret sits at the end of, or `nil`. The `#` starts a
    /// word (desktop's `(^|[\s\ufffc])#`), and everything after it up to the
    /// caret is tag characters.
    static func active(in text: String, caret: Int) -> HashTagTrigger? {
        let string = text as NSString
        guard caret > 0, caret <= string.length else { return nil }
        var index = caret - 1
        while index >= 0, caret - index <= 40 {
            let character = string.character(at: index)
            if character == 35 { // "#"
                if index > 0 {
                    let before = string.character(at: index - 1)
                    guard before == 32 || before == 9 || before == 10 || before == 0xA0 || before == 0xFFFC else { return nil }
                }
                let query = string.substring(with: NSRange(location: index + 1, length: caret - index - 1))
                return HashTagTrigger(range: NSRange(location: index, length: caret - index), query: query)
            }
            // A letter outside the BMP is two UTF-16 units: read it whole.
            if UTF16.isTrailSurrogate(character), index > 0,
               UTF16.isLeadSurrogate(string.character(at: index - 1)) {
                let pair = string.substring(with: NSRange(location: index - 1, length: 2))
                guard let scalar = pair.unicodeScalars.first, isTagCharacter(scalar) else { return nil }
                index -= 2
                continue
            }
            guard let scalar = Unicode.Scalar(character), isTagCharacter(scalar) else { return nil }
            index -= 1
        }
        return nil
    }
}

/// One row of the `#` menu.
struct TagSuggestion: Identifiable, Equatable {
    let tag: String
    /// A tag the vault does not have yet.
    let isNew: Bool

    var id: String { (isNew ? "new:" : "tag:") + tag }
    var title: String { isNew ? "Create #\(tag)" : "#\(tag)" }
}

enum TagSuggestions {
    /// Desktop's popover shows eight.
    static let limit = 8

    /// Vault tags containing `query`, prefix matches first, then a create row
    /// when no tag is exactly `query`. An empty query lists the tags in the
    /// order given (most used first).
    static func rank(query: String, tags: [String]) -> [TagSuggestion] {
        let lower = query.lowercased()
        let matched: [String]
        if lower.isEmpty {
            matched = tags
        } else {
            let prefixed = tags.filter { $0.lowercased().hasPrefix(lower) }
            let contained = tags.filter { !$0.lowercased().hasPrefix(lower) && $0.lowercased().contains(lower) }
            matched = prefixed + contained
        }
        var out = matched.prefix(limit).map { TagSuggestion(tag: $0, isNew: false) }
        if !query.isEmpty, !tags.contains(where: { $0.lowercased() == lower }) {
            out.append(TagSuggestion(tag: query, isNew: true))
        }
        return out
    }
}

/// A `hashTag` node's props, as desktop's `handleTagSuggestionSelect` writes
/// them: the tag, its chosen colour or the one its name hashes to, and the
/// icon (desktop fills it from its own tag icons; this shell has none, and
/// desktop re-icons the node when it opens the note).
enum HashTagAttrs {
    static func attrs(tag: String, colors: [String: String]) -> [String: String] {
        let color = colors[tag.lowercased()] ?? Tokens.Palette.defaultName(for: tag)
        return ["tag": tag, "color": color, "icon": ""]
    }
}
