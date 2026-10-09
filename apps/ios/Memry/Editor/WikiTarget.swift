//
//  WikiTarget.swift
//  Reading a wiki-link target's text for presentation: its note and heading
//  halves, and the path stem a link to a duplicate-titled note writes.
//
//  Desktop reference: `packages/shared/src/wiki-target.ts`. Resolution itself
//  is the core's (`Notes.resolveWikiTarget`); this only draws and suggests.
//

import Foundation
import MemryCore

/// A note the `[[` menu can link to.
struct WikiLinkNote: Equatable, Sendable {
    let title: String
    /// The note's folder from the vault root, `nil` at the root.
    let folderPath: String?
}

enum WikiTarget {
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
    static func pathKey(of note: WikiLinkNote) -> String {
        let folder = note.folderPath?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        return (folder.isEmpty ? note.title : "\(folder)/\(note.title)").lowercased()
    }

    /// What a link to `note` writes when another note shares its title: the
    /// vault-root path stem, `/Title` at the root (desktop's `linkTargetFor`).
    static func pathStem(of note: WikiLinkNote) -> String {
        let folder = note.folderPath?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        return folder.isEmpty ? "/\(note.title)" : "\(folder)/\(note.title)"
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
