//
//  SlashMenu.swift
//  The block catalog every insert surface reads: the `/` menu and the
//  keyboard toolbar's `+` grid. Desktop's slash menu rows this build can act
//  on, in desktop's order, filtered as desktop filters them.
//
//  Desktop references: `slash-menu-model.ts` (catalog order, groups and
//  scoring), `ContentArea.tsx` (the rows Memry adds), BlockNote's `en.ts`
//  dictionary and `getDefaultSlashMenuItems.ts` (titles, aliases, props).
//

import Foundation
import MemryCore
import UIKit

enum BlockCatalog {
    enum Section: CaseIterable, Sendable {
        case basic, headings, insert, media

        var title: String {
            switch self {
            case .basic: "Basic"
            case .headings: "Headings"
            case .insert: "Insert"
            case .media: "Media"
            }
        }
    }

    /// `id` is desktop's row id.
    struct Row: Identifiable, Equatable, Sendable {
        enum Action: Equatable, Sendable {
            /// The block becomes (or a new block after it is) `kind`.
            case block(kind: String, level: Int?, props: [String: String])
            /// Types `[[`, which opens the wiki-link menu.
            case linkToNote
            /// Today, or desktop's reminder default, worked out when chosen.
            case date(remind: Bool)
            /// Opens a picker; the upload lands as desktop's image or file block.
            case attach(EditorAttachmentSource)
            case link(LinkBlock.Kind)
        }

        let id: String
        let title: String
        let symbol: String
        let aliases: [String]
        let section: Section
        let action: Action
    }

    private static func block(
        _ id: String, _ title: String, _ symbol: String, _ aliases: [String], _ section: Section,
        kind: String, level: Int? = nil, props: [String: String] = [:]
    ) -> Row {
        Row(id: id, title: title, symbol: symbol, aliases: aliases, section: section, action: .block(kind: kind, level: level, props: props))
    }

    private static let dateAliases = ["date", "remind", "reminder", "when"]

    /// Every row, in desktop's catalog order. Rows desktop offers that this
    /// build cannot make yet (task, math, diagram, whiteboard, view,
    /// pdf, media, html) join here one row each as they land; emoji,
    /// templates and AI stay desktop-only.
    static let rows: [Row] = [
        block("paragraph", "Paragraph", "text.alignleft", ["p", "paragraph"], .basic, kind: "paragraph"),
        block("heading", "Heading 1", "textformat.size.larger", ["h", "heading1", "h1"], .basic, kind: "heading", level: 1),
        block("heading_2", "Heading 2", "textformat.size", ["h2", "heading2", "subheading"], .basic, kind: "heading", level: 2),
        block("heading_3", "Heading 3", "textformat.size.smaller", ["h3", "heading3", "subheading"], .basic, kind: "heading", level: 3),
        block("bullet_list", "Bullet List", "list.bullet", ["ul", "li", "list", "bulletlist", "bullet list"], .basic, kind: "bulletListItem"),
        block("numbered_list", "Numbered List", "list.number", ["ol", "li", "list", "numberedlist", "numbered list"], .basic, kind: "numberedListItem"),
        // Desktop's `/check` makes a plain checkbox; `[] ` is the way to a task.
        block(
            "check_list", "Check List", "checklist",
            ["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], .basic,
            kind: "checkListItem", props: ["plain": "true"]
        ),
        block("toggle_list", "Toggle List", "chevron.right.circle", ["li", "list", "toggleList", "toggle list", "collapsable list"], .basic, kind: "toggleListItem"),
        block("quote", "Quote", "quote.opening", ["quotation", "blockquote", "bq"], .basic, kind: "quote"),
        block("callout", "Callout", "exclamationmark.bubble", ["callout", "admonition", "alert", "notice", "tip"], .basic, kind: "callout"),
        block("code_block", "Code Block", "curlybraces", ["code", "pre"], .basic, kind: "codeBlock"),
        block("divider", "Divider", "minus", ["divider", "hr", "line", "horizontal rule"], .basic, kind: "divider"),
        block("heading_4", "Heading 4", "textformat", ["h4", "heading4", "subheading4"], .headings, kind: "heading", level: 4),
        block("heading_5", "Heading 5", "textformat", ["h5", "heading5", "subheading5"], .headings, kind: "heading", level: 5),
        block("heading_6", "Heading 6", "textformat", ["h6", "heading6", "subheading6"], .headings, kind: "heading", level: 6),
        block(
            "toggle_heading", "Toggle Heading 1", "chevron.right.square", ["h", "heading1", "h1", "collapsable"], .headings,
            kind: "heading", level: 1, props: ["isToggleable": "true"]
        ),
        block(
            "toggle_heading_2", "Toggle Heading 2", "chevron.right.square", ["h2", "heading2", "subheading", "collapsable"], .headings,
            kind: "heading", level: 2, props: ["isToggleable": "true"]
        ),
        block(
            "toggle_heading_3", "Toggle Heading 3", "chevron.right.square", ["h3", "heading3", "subheading", "collapsable"], .headings,
            kind: "heading", level: 3, props: ["isToggleable": "true"]
        ),
        Row(id: "link_to_note", title: "Link to note", symbol: "link", aliases: ["link", "wiki", "wikilink", "note", "backlink"], section: .insert, action: .linkToNote),
        Row(id: "date", title: "Today", symbol: "calendar", aliases: dateAliases, section: .insert, action: .date(remind: false)),
        Row(id: "remind", title: "Remind me", symbol: "alarm", aliases: dateAliases, section: .insert, action: .date(remind: true)),
        block("table", "Table", "tablecells", ["table"], .insert, kind: "table"),
        // Mobile's own rows: desktop makes these from a pasted link instead.
        Row(id: "bookmark", title: "Bookmark", symbol: "bookmark", aliases: ["bookmark", "link", "url", "web"], section: .insert, action: .link(.bookmark)),
        Row(id: "youtube", title: "YouTube video", symbol: "play.rectangle", aliases: ["youtube", "video", "embed", "yt"], section: .insert, action: .link(.youtube)),
        Row(
            id: "image", title: "Image", symbol: "photo",
            aliases: ["image", "imageUpload", "upload", "img", "picture", "media", "url", "photo"],
            section: .media, action: .attach(.photos)
        ),
        Row(
            id: "video", title: "Video", symbol: "film",
            aliases: ["video", "videoUpload", "upload", "mp4", "film", "media", "url"],
            section: .media, action: .attach(.videos)
        ),
        Row(
            id: "audio", title: "Audio", symbol: "waveform",
            aliases: ["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"],
            section: .media, action: .attach(.audio)
        ),
        Row(
            id: "file", title: "File", symbol: "doc",
            aliases: ["file", "upload", "embed", "media", "url", "attachment"],
            section: .media, action: .attach(.files)
        ),
    ]

    /// The rows a surface offers. `attach` is false where no picker is
    /// wired, which hides the media rows rather than offering an upload that
    /// cannot happen.
    static func rows(attach: Bool) -> [Row] {
        attach ? rows : rows.filter { if case .attach = $0.action { false } else { true } }
    }

    /// `rows(attach:)` under their section titles, empty sections left out:
    /// the `+` grid.
    static func sections(attach: Bool) -> [(section: Section, rows: [Row])] {
        let rows = rows(attach: attach)
        return Section.allCases.compactMap { section in
            let inSection = rows.filter { $0.section == section }
            return inSection.isEmpty ? nil : (section, inSection)
        }
    }

    /// The date a date row inserts, and what its subtitle says, as of `now`:
    /// the `@` menu's own rows for an empty query.
    static func mention(remind: Bool, now: Date = .now, calendar: Calendar = .current) -> EditorSuggestion? {
        EditorSuggestions.mention(query: "", titles: [], now: now, calendar: calendar)
            .first { $0.id == (remind ? "remind" : "date") }
    }

    /// Desktop's `buildSlashMenuItems` without groups or recents: every match
    /// in catalog order, with the single best match lifted to the top.
    static func filter(_ items: [Row], query: String) -> [Row] {
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
    private static func score(_ item: Row, _ needle: String) -> Int? {
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
}

@MainActor
enum SlashMenu {
    static func suggestions(query: String, attach: Bool, now: Date = .now) -> [EditorSuggestion] {
        BlockCatalog.filter(BlockCatalog.rows(attach: attach), query: query).map { row in
            let subtitle: String? = switch row.action {
            case .linkToNote: "[["
            case .date(remind: true): BlockCatalog.mention(remind: true, now: now)?.subtitle
            default: nil
            }
            return EditorSuggestion(id: "slash:\(row.id)", title: row.title, subtitle: subtitle, symbol: row.symbol, kind: .slash(row))
        }
    }
}

extension EditorSession {
    /// The slash menu rows for `query`, empty inside a code block, where
    /// desktop opens no menu.
    func slashSuggestions(query: String) -> [EditorSuggestion] {
        guard field?.block.kind != "codeBlock" else { return [] }
        return SlashMenu.suggestions(query: query, attach: attach != nil)
    }

    /// A slash row chosen: `/query` goes, then the row acts.
    func chooseSlash(_ row: BlockCatalog.Row) {
        guard let field, let trigger, case .slash = trigger else { return }
        if case let .date(remind) = row.action {
            // The date node replaces `/query` through the `@` path.
            if let mention = BlockCatalog.mention(remind: remind) { choose(mention) }
            return
        }
        let textView = field.textView
        textView.textStorage.replaceCharacters(in: trigger.range, with: "")
        textView.selectedRange = NSRange(location: trigger.range.location, length: 0)
        field.dirty = true
        textView.invalidateIntrinsicContentSize()
        selectionChanged(in: field)
        run(row, in: field)
    }

    /// A `+` grid row chosen: the grid closes, then the row acts at the caret
    /// as the same slash row would.
    func chooseFromGrid(_ row: BlockCatalog.Row) {
        guard let field else { return }
        show(.none)
        if case let .date(remind) = row.action {
            if let mention = BlockCatalog.mention(remind: remind) {
                insertInline(mention.kind, replacing: field.textView.selectedRange)
            }
            return
        }
        run(row, in: field)
    }

    private func run(_ row: BlockCatalog.Row, in field: BlockField) {
        switch row.action {
        case let .block(kind, level, props):
            insertOrTurn(field, kind: kind, level: level, props: props)
        case .linkToNote:
            startWikiLink()
        case let .attach(source):
            openAttachment(source)
        case let .link(kind):
            requestLink(kind)
        case .date:
            break
        }
    }

    /// An empty block changes type; a block with text keeps it and gets the
    /// new block after (BlockNote's `insertOrUpdateBlockForSlashMenu`).
    private func insertOrTurn(_ field: BlockField, kind: String, level: Int?, props: [String: String]) {
        let blockId = field.blockId
        let empty = field.textView.text.isEmpty
        if empty, kind != "divider" {
            // A table draws in the reload the turn itself triggers, so it
            // asks for the caret before that write rather than after it.
            if kind == "table" { pendingFocus = blockId }
            turnInto(InsertableBlock(id: kind, name: "", symbol: "", level: level))
            commit(field) { [weak self] in
                guard let self, let model = self.model else { return }
                for (name, value) in props.sorted(by: { $0.key < $1.key }) {
                    await model.setProp(blockId, name, value)
                }
                if kind != "table" { self.pendingFocus = blockId }
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
