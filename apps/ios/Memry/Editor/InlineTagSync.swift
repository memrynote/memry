//
//  InlineTagSync.swift
//  A `#tag` in the body is one of the note's tags, as on desktop
//  (`extractInlineTags` and `handleInlineTagsChange` in `pages/note.tsx`).
//

import MemryCore

@MainActor
enum InlineTagSync {
    /// The body's tags: each `hashTag` node and each `#tag` typed as text,
    /// deduplicated case-insensitively with the first spelling kept. Not in a
    /// code block, whose text is literal.
    static func tags(in blocks: [Block]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        func add(_ tag: String) {
            guard !tag.isEmpty, seen.insert(tag.lowercased()).inserted else { return }
            out.append(tag)
        }
        for block in blocks where block.kind != "codeBlock" {
            for run in block.inline {
                if run.marks.contains("hashTag") {
                    add(NoteInline.tagName(of: run))
                } else if !BlockText.isNode(run) {
                    HashTagText.matches(in: run.text).forEach { add($0.tag) }
                }
            }
        }
        return out
    }

    /// The note's tags after the body went from `previous` to `current`: a
    /// tag that appeared is added, and one that left the body is removed if
    /// the note has it. A tag the body never mentioned is left alone, so one
    /// added from the tags row survives. `nil` when nothing changes.
    static func next(noteTags: [String], previous: [String], current: [String]) -> [String]? {
        let before = Set(previous.map { $0.lowercased() })
        let after = Set(current.map { $0.lowercased() })
        let has = Set(noteTags.map { $0.lowercased() })
        let added = current.filter { !before.contains($0.lowercased()) && !has.contains($0.lowercased()) }
        let removed = before.subtracting(after)
        guard !added.isEmpty || noteTags.contains(where: { removed.contains($0.lowercased()) }) else { return nil }
        return noteTags.filter { !removed.contains($0.lowercased()) } + added
    }
}
