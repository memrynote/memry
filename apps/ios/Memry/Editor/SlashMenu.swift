//
//  SlashMenu.swift
//  The `/` menu: desktop's slash menu rows this build can act on, filtered
//  as desktop filters them, shown in the `[[` / `@` suggestion list.
//
//  Desktop references: `slash-menu-model.ts` (catalog order and scoring),
//  `ContentArea.tsx` (the rows Memry adds), BlockNote's `en.ts` dictionary
//  (titles and aliases).
//

import Foundation
import MemryCore
import UIKit

/// One row of the `/` menu. `id` is desktop's row id.
struct SlashMenuItem: Equatable, Sendable {
    enum Action: Equatable, Sendable {
        /// The block becomes (or a new block after it is) `kind`.
        case block(kind: String, level: Int?, props: [String: String])
        /// Types `[[`, which opens the wiki-link menu.
        case linkToNote
        case date(DateMentionValue)
        case picture
    }

    let id: String
    let title: String
    var subtitle: String?
    let symbol: String
    let aliases: [String]
    let action: Action
}

@MainActor
enum SlashMenu {
    /// Every row at rest, in desktop's catalog order: blocks, more headings,
    /// insert, media. Rows desktop offers that this build cannot make (table,
    /// math, diagram, whiteboard, view, task, emoji, templates, toggle
    /// headings, AI, files) are left out rather than shown and refused.
    static func catalog(now: Date = .now, calendar: Calendar = .current, picture: Bool) -> [SlashMenuItem] {
        func block(_ id: String, _ title: String, _ symbol: String, _ aliases: [String], kind: String, level: Int? = nil, props: [String: String] = [:]) -> SlashMenuItem {
            SlashMenuItem(id: id, title: title, symbol: symbol, aliases: aliases, action: .block(kind: kind, level: level, props: props))
        }
        var items: [SlashMenuItem] = [
            block("paragraph", "Paragraph", "text.alignleft", ["p", "paragraph"], kind: "paragraph"),
            block("heading", "Heading 1", "textformat.size.larger", ["h", "heading1", "h1"], kind: "heading", level: 1),
            block("heading_2", "Heading 2", "textformat.size", ["h2", "heading2", "subheading"], kind: "heading", level: 2),
            block("heading_3", "Heading 3", "textformat.size.smaller", ["h3", "heading3", "subheading"], kind: "heading", level: 3),
            block("bullet_list", "Bullet List", "list.bullet", ["ul", "li", "list", "bulletlist", "bullet list"], kind: "bulletListItem"),
            block("numbered_list", "Numbered List", "list.number", ["ol", "li", "list", "numberedlist", "numbered list"], kind: "numberedListItem"),
            // Desktop's `/check` makes a plain checkbox; `[] ` is the way to a task.
            block("check_list", "Check List", "checklist", ["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], kind: "checkListItem", props: ["plain": "true"]),
            block("toggle_list", "Toggle List", "chevron.right.circle", ["li", "list", "toggleList", "toggle list", "collapsable list"], kind: "toggleListItem"),
            block("quote", "Quote", "quote.opening", ["quotation", "blockquote", "bq"], kind: "quote"),
            block("callout", "Callout", "exclamationmark.bubble", ["callout", "admonition", "alert", "notice", "tip"], kind: "callout"),
            block("code_block", "Code Block", "curlybraces", ["code", "pre"], kind: "codeBlock"),
            block("divider", "Divider", "minus", ["divider", "hr", "line", "horizontal rule"], kind: "divider"),
            block("heading_4", "Heading 4", "textformat", ["h4", "heading4", "subheading4"], kind: "heading", level: 4),
            block("heading_5", "Heading 5", "textformat", ["h5", "heading5", "subheading5"], kind: "heading", level: 5),
            block("heading_6", "Heading 6", "textformat", ["h6", "heading6", "subheading6"], kind: "heading", level: 6),
            SlashMenuItem(id: "link_to_note", title: "Link to note", subtitle: "[[", symbol: "link", aliases: ["link", "wiki", "wikilink", "note", "backlink"], action: .linkToNote),
        ]
        // Desktop's two date rows: today, and a reminder, sharing aliases.
        let dates = EditorSuggestions.mention(query: "", titles: [], now: now, calendar: calendar)
        let dateAliases = ["date", "remind", "reminder", "when"]
        for row in dates {
            guard case let .date(value) = row.kind else { continue }
            let remind = value.remind == "at"
            items.append(SlashMenuItem(
                id: remind ? "remind" : "date", title: row.title, subtitle: row.subtitle,
                symbol: row.symbol, aliases: dateAliases, action: .date(value)
            ))
        }
        if picture {
            items.append(SlashMenuItem(id: "image", title: "Image", symbol: "photo", aliases: ["image", "imageUpload", "upload", "img", "picture", "media", "url", "photo"], action: .picture))
        }
        return items
    }

    /// Desktop's `buildSlashMenuItems` without groups or recents: every match
    /// in catalog order, with the single best match lifted to the top.
    static func filter(_ items: [SlashMenuItem], query: String) -> [SlashMenuItem] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return items }
        let matches = items.compactMap { item in score(item, needle).map { (item, $0) } }
        guard let best = matches.min(by: { $0.1 < $1.1 }) else { return [] }
        guard best.0 != matches[0].0 else { return matches.map(\.0) }
        return [best.0] + matches.filter { $0.0 != best.0 }.map(\.0)
    }

    private static let wordBoundary = CharacterSet(charactersIn: " -_/(").union(.whitespaces)

    /// Title prefix, then a title word, then anywhere in the title, then an
    /// alias prefix, then anywhere in an alias (`scoreItem`).
    private static func score(_ item: SlashMenuItem, _ needle: String) -> Int? {
        let title = item.title.lowercased()
        if let range = title.range(of: needle) {
            if range.lowerBound == title.startIndex { return 0 }
            let before = title[title.index(before: range.lowerBound)]
            if before.unicodeScalars.allSatisfy({ wordBoundary.contains($0) }) { return 1 }
            return 2
        }
        if item.aliases.contains(where: { $0.lowercased().hasPrefix(needle) }) { return 3 }
        if item.aliases.contains(where: { $0.lowercased().contains(needle) }) { return 4 }
        return nil
    }

    static func suggestions(query: String, picture: Bool, now: Date = .now) -> [EditorSuggestion] {
        filter(catalog(now: now, picture: picture), query: query).map {
            EditorSuggestion(id: "slash:\($0.id)", title: $0.title, subtitle: $0.subtitle, symbol: $0.symbol, kind: .slash($0))
        }
    }
}

extension EditorSession {
    /// The slash menu rows for `query`, empty inside a code block, where
    /// desktop opens no menu.
    func slashSuggestions(query: String) -> [EditorSuggestion] {
        guard field?.block.kind != "codeBlock" else { return [] }
        return SlashMenu.suggestions(query: query, picture: pickImage != nil)
    }

    /// A slash row chosen: `/query` goes, then the row acts. An empty block
    /// changes type; a block with text keeps it and gets the new block after
    /// (BlockNote's `insertOrUpdateBlockForSlashMenu`).
    func chooseSlash(_ item: SlashMenuItem) {
        guard let field, let trigger, case .slash = trigger else { return }
        let textView = field.textView
        if case let .date(value) = item.action {
            // The date node replaces `/query` through the `@` path.
            choose(EditorSuggestion(id: item.id, title: item.title, symbol: item.symbol, kind: .date(value)))
            return
        }
        textView.textStorage.replaceCharacters(in: trigger.range, with: "")
        textView.selectedRange = NSRange(location: trigger.range.location, length: 0)
        field.dirty = true
        textView.invalidateIntrinsicContentSize()
        selectionChanged(in: field)

        switch item.action {
        case let .block(kind, level, props):
            insertOrTurn(field, kind: kind, level: level, props: props)
        case .linkToNote:
            startWikiLink()
        case .picture:
            pickImage?()
        case .date:
            break
        }
    }

    private func insertOrTurn(_ field: BlockField, kind: String, level: Int?, props: [String: String]) {
        let blockId = field.blockId
        let empty = field.textView.text.isEmpty
        if empty, kind != "divider" {
            turnInto(InsertableBlock(id: kind, name: "", symbol: "", level: level))
            commit(field) { [weak self] in
                guard let self, let model = self.model else { return }
                for (name, value) in props.sorted(by: { $0.key < $1.key }) {
                    await model.setProp(blockId, name, value)
                }
                self.pendingFocus = blockId
            }
            return
        }
        let previous = field.block.kind
        commit(field) { [weak self] in
            guard let self, let model = self.model else { return }
            if empty {
                // An empty block becomes the divider; the caret goes to a new
                // line after it.
                await model.turnInto(blockId, kind: "divider")
                self.history.record(.turnInto(blockId: blockId, from: previous, to: "divider"))
                guard let newId = await model.insert("paragraph", after: blockId) else { return }
                self.history.record(.insert(blockId: newId, after: blockId, kind: "paragraph", text: ""))
                self.pendingFocus = newId
                return
            }
            guard let newId = await model.insert(kind, after: blockId) else { return }
            if let level { await model.setProp(newId, "level", String(level)) }
            for (name, value) in props.sorted(by: { $0.key < $1.key }) {
                await model.setProp(newId, name, value)
            }
            self.history.record(.insert(blockId: newId, after: blockId, kind: kind, text: ""))
            guard kind == "divider" else {
                self.pendingFocus = newId
                return
            }
            guard let lineId = await model.insert("paragraph", after: newId) else { return }
            self.history.record(.insert(blockId: lineId, after: newId, kind: "paragraph", text: ""))
            self.pendingFocus = lineId
        }
    }
}
