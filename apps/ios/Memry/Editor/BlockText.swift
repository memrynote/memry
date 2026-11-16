//
//  BlockText.swift
//  A block's runs as the editable attributed text a `UITextView` holds, and
//  the offsets between that text and the core's.
//
//  The text view spells every inline node as one U+FFFC (an attachment chip),
//  which is exactly the spelling `BlockEdit.replaceText` diffs against. Marks
//  and node offsets travel in the core's unit: UTF-8 bytes, with an inline
//  node counting as the text it holds (nothing, for desktop's atom nodes).
//

import MemryCore
import SwiftUI
import UIKit

extension NSAttributedString.Key {
    /// The mark names a character carries, for the toolbar's on/off state.
    static let memryMarks = NSAttributedString.Key("memry.marks")
    /// On a U+FFFC: the bytes its node occupies in the core's offsets.
    static let memryNodeBytes = NSAttributedString.Key("memry.nodeBytes")
    /// On a `hashTag` chip or a `#tag` typed as text: the tag a tap opens.
    static let memryTag = NSAttributedString.Key("memry.tag")
    /// On a `dateMention` chip: the `DateMentionChip` a tap edits.
    static let memryDate = NSAttributedString.Key("memry.date")
    /// On a `wikiLink` chip or a `[[...]]` typed as text: the target a tap opens.
    static let memryWikiTarget = NSAttributedString.Key("memry.wikiTarget")
}

@MainActor
enum BlockText {
    nonisolated static let placeholder = "\u{FFFC}"

    /// BlockNote's inline nodes, which the core carries as elements.
    nonisolated static let nodeKinds: Set<String> = [
        "wikiLink", "hashTag", "dateMention", "linkMention", "inlineImage", "inlineCheckbox",
        "htmlComment",
    ]

    nonisolated static func isNode(_ run: InlineRun) -> Bool {
        run.marks.contains { nodeKinds.contains($0) }
    }

    struct Segment: Equatable {
        let run: InlineRun
        let isNode: Bool
        /// A node with text of its own spans several runs; they collapse into
        /// one segment, as the core counts one element.
        var coreBytes: Int
        var text: String
    }

    nonisolated static func segments(_ runs: [InlineRun]) -> [Segment] {
        var out: [Segment] = []
        for run in runs {
            let node = isNode(run)
            if node, !run.text.isEmpty, let last = out.last, last.isNode, !last.text.isEmpty,
               nodeAttrs(last.run) == nodeAttrs(run) {
                out[out.count - 1].coreBytes += run.text.utf8.count
                out[out.count - 1].text += run.text
                continue
            }
            out.append(Segment(run: run, isNode: node, coreBytes: run.text.utf8.count, text: run.text))
        }
        return out
    }

    nonisolated private static func nodeAttrs(_ run: InlineRun) -> [String: String] {
        run.markAttrs.filter { key, _ in nodeKinds.contains { key.hasPrefix($0 + ".") } }
            .merging(["_tag": run.marks.first { nodeKinds.contains($0) } ?? ""]) { $1 }
    }

    /// The block as the text view spells it.
    nonisolated static func shown(_ runs: [InlineRun]) -> String {
        segments(runs).map { $0.isNode ? placeholder : $0.text }.joined()
    }

    /// The core offset of a UTF-16 position in `shown(runs)`.
    nonisolated static func coreOffset(in runs: [InlineRun], shown offset: Int) -> Int {
        var left = offset
        var bytes = 0
        for segment in segments(runs) where left > 0 {
            if segment.isNode {
                left -= 1
                bytes += segment.coreBytes
            } else {
                let text = segment.text as NSString
                bytes += text.substring(to: min(left, text.length)).utf8.count
                left -= text.length
            }
        }
        return bytes
    }

    /// The core offset of a UTF-16 position in the text view's text.
    static func coreOffset(in text: NSAttributedString, utf16 offset: Int) -> Int {
        let end = min(max(offset, 0), text.length)
        var bytes = 0
        var index = 0
        while index < end {
            bytes += coreBytes(in: text, at: &index)
        }
        return bytes
    }

    /// The UTF-16 position of a core offset in the text view's text: the
    /// first one that many bytes in.
    static func utf16Offset(in text: NSAttributedString, core offset: Int) -> Int {
        var bytes = 0
        var index = 0
        while index < text.length, bytes < offset {
            bytes += coreBytes(in: text, at: &index)
        }
        return index
    }

    /// The core bytes of the character at `index`, which moves past it.
    private static func coreBytes(in text: NSAttributedString, at index: inout Int) -> Int {
        let range = (text.string as NSString).rangeOfComposedCharacterSequence(at: index)
        let piece = (text.string as NSString).substring(with: range)
        defer { index = NSMaxRange(range) }
        if piece == placeholder,
           let nodeBytes = text.attribute(.memryNodeBytes, at: index, effectiveRange: nil) as? Int {
            return nodeBytes
        }
        return piece.utf8.count
    }

    /// `text` with an atom node, a U+FFFC of no core bytes, put over each
    /// core range in turn: the block as the core holds it once those
    /// `insertInline`s land on `text`. Then that block with each of those
    /// nodes, last first, turned back into the text it went over, or a
    /// space for one that went over none. The core diffs `ReplaceText` by
    /// prefix and suffix, so dropping a U+FFFC beside another node can drop
    /// that node instead (VERIFY-4700); changing one U+FFFC into other text
    /// changes exactly that one.
    static func placingNodes(_ spans: [Range<Int>], in text: NSAttributedString) -> [String] {
        let result = NSMutableAttributedString(attributedString: text)
        let placed = NSAttributedString.Key("memry.placed")
        for span in spans {
            var lower = utf16Offset(in: result, core: span.lowerBound)
            // A node over text starts at that text, after any node of no
            // core bytes at the same offset: a tag picked right after a
            // link would otherwise cover the link (VERIFY-4753).
            var next = lower
            while !span.isEmpty, next < result.length, coreBytes(in: result, at: &next) == 0 { lower = next }
            let upper = max(lower, utf16Offset(in: result, core: span.upperBound))
            let range = NSRange(location: lower, length: upper - lower)
            let covered = (result.string as NSString).substring(with: range)
            result.replaceCharacters(
                in: range,
                with: NSAttributedString(
                    string: placeholder, attributes: [.memryNodeBytes: 0, placed: covered.isEmpty ? " " : covered]
                )
            )
        }
        var chain = [result.string]
        for location in (0 ..< result.length).reversed() {
            guard let covered = result.attribute(placed, at: location, effectiveRange: nil) as? String else { continue }
            result.replaceCharacters(in: NSRange(location: location, length: 1), with: covered)
            chain.append(result.string)
        }
        return chain
    }

    /// `base` to `text` as one change per run of text between inline nodes,
    /// when both hold the same nodes: the text after each change, in order.
    /// The core diffs `ReplaceText` by one common prefix and suffix, so
    /// typing on both sides of a node in one write spans the node and
    /// deletes it (VERIFY-4700). Typing never adds a node, so an equal
    /// count is the same nodes.
    static func stepsAroundNodes(from base: String, to text: String) -> [String] {
        let old = base.components(separatedBy: placeholder)
        let new = text.components(separatedBy: placeholder)
        guard old.count == new.count else { return [text] }
        var parts = old
        var steps: [String] = []
        for index in parts.indices where parts[index] != new[index] {
            parts[index] = new[index]
            steps.append(parts.joined(separator: placeholder))
        }
        return steps.isEmpty ? [text] : steps
    }

    /// `range` in `old` moved onto `new`, in UTF-16: the text both share
    /// before and after the change holds still, so a caret after the change
    /// moves by its length, one before it stays, and one inside it goes to
    /// its end.
    static func carry(_ range: NSRange, from old: String, to new: String) -> NSRange {
        let (prefix, suffix) = sharedEnds(old, new)
        let old = Array(old.utf16)
        let new = Array(new.utf16)
        let changedEnd = old.count - suffix
        let move = { (location: Int) -> Int in
            if location <= prefix { return location }
            if location >= changedEnd { return location + new.count - old.count }
            return new.count - suffix
        }
        let start = move(range.location)
        return NSRange(location: start, length: max(0, move(NSMaxRange(range)) - start))
    }

    /// `length` UTF-16 units at `location` in `old`, found in `new` as
    /// `carry` moves them, or `nil` when the change between them touches
    /// them: their place is no longer known.
    nonisolated static func follow(_ location: Int, length: Int, from old: String, to new: String) -> Int? {
        let (prefix, suffix) = sharedEnds(old, new)
        let delta = new.utf16.count - old.utf16.count
        if location + length <= prefix { return location }
        if location >= old.utf16.count - suffix { return location + delta }
        return nil
    }

    /// The UTF-16 units `old` and `new` share at their start, then at their
    /// end, not overlapping.
    nonisolated private static func sharedEnds(_ old: String, _ new: String) -> (prefix: Int, suffix: Int) {
        let old = Array(old.utf16)
        let new = Array(new.utf16)
        let shortest = min(old.count, new.count)
        var prefix = 0
        while prefix < shortest, old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < shortest - prefix, old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        return (prefix, suffix)
    }

    // MARK: - Drawing

    struct Style {
        var font: UIFont
        var ink: UIColor
        var titleExists: ((String) -> Bool)?
        /// The vault's tag colours by lowercased name, for a tag whose node
        /// carries none.
        var tagColors: [String: String] = [:]
    }

    static func attributed(_ runs: [InlineRun], style: Style) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for segment in segments(runs) {
            if segment.isNode {
                out.append(chip(segment, style: style))
            } else {
                out.append(NSAttributedString(string: segment.text, attributes: attributes(segment.run, style: style)))
            }
        }
        return out
    }

    /// Draws each `#tag` typed as text as a tag and marks it for a tap
    /// (`HashTagText`). Display only: the text, its marks and its core
    /// offsets stay as they are. Not over code or a link, whose text is
    /// literal; the caller skips a code block.
    static func markTags(in text: NSMutableAttributedString, colors: [String: String] = [:]) {
        for match in HashTagText.matches(in: text.string) {
            var literal = false
            text.enumerateAttribute(.memryMarks, in: match.range) { value, _, stop in
                let marks = value as? [String] ?? []
                if marks.contains("code") || marks.contains("link") || marks.contains("href") {
                    literal = true
                    stop.pointee = true
                }
            }
            guard !literal else { continue }
            let ink = UIColor(Tokens.Palette.color(colors[match.tag.lowercased()], tag: match.tag))
            let size = (text.attribute(.font, at: match.range.location, effectiveRange: nil) as? UIFont)?.pointSize
                ?? UIFont.preferredFont(forTextStyle: .body).pointSize
            // The fill is drawn rounded by `TagPillLayoutManager`; the kerns
            // around the tag make room for its padding.
            text.addAttributes(
                [
                    .foregroundColor: ink,
                    .backgroundColor: ink.withAlphaComponent(Tokens.Palette.chipFillAlpha),
                    .font: UIFont.systemFont(ofSize: size * 0.9, weight: .medium),
                    .memryTag: match.tag,
                ],
                range: match.range
            )
            if match.range.location > 0 {
                text.addAttribute(.kern, value: tagPillPadding, range: NSRange(location: match.range.location - 1, length: 1))
            }
            text.addAttribute(.kern, value: tagPillPadding, range: NSRange(location: NSMaxRange(match.range) - 1, length: 1))
        }
    }

    /// Draws each `[[...]]` typed as text as a link and marks it for a tap
    /// (`WikiTarget.literals`), as the core indexes it (#3318). Display only,
    /// like `markTags`. Not over code; the caller skips a code block.
    static func markWikiLinks(in text: NSMutableAttributedString, titleExists: ((String) -> Bool)?) {
        for match in WikiTarget.literals(in: text.string) {
            var code = false
            text.enumerateAttribute(.memryMarks, in: match.range) { value, _, stop in
                if (value as? [String] ?? []).contains("code") {
                    code = true
                    stop.pointee = true
                }
            }
            guard !code else { continue }
            let known = titleExists?(match.target) != false
            text.addAttributes(
                [
                    .foregroundColor: UIColor(known ? Tokens.Text.tint.color : Tokens.Text.secondary.color),
                    .memryWikiTarget: match.target,
                ],
                range: match.range
            )
        }
    }

    /// The room on each side of a typed `#tag`'s fill.
    nonisolated static let tagPillPadding: CGFloat = 6

    /// What a character typed with nothing to its left carries.
    static func baseAttributes(_ style: Style) -> [NSAttributedString.Key: Any] {
        [.font: style.font, .foregroundColor: style.ink, .memryMarks: [String]()]
    }

    static func attributes(_ run: InlineRun, style: Style) -> [NSAttributedString.Key: Any] {
        var attrs = baseAttributes(style)
        var traits: UIFontDescriptor.SymbolicTraits = []
        var font = style.font
        for mark in run.marks {
            switch mark {
            case "bold": traits.insert(.traitBold)
            case "italic": traits.insert(.traitItalic)
            case "code":
                font = UIFont.monospacedSystemFont(ofSize: style.font.pointSize, weight: .regular)
            case "strike": attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case "underline": attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case "textColor":
                if let name = run.markAttrs[mark], let ink = Tokens.Content.ink(named: name) {
                    attrs[.foregroundColor] = UIColor(ink.color)
                }
            case "backgroundColor":
                if let name = run.markAttrs[mark], let fill = Tokens.Content.fill(named: name) {
                    attrs[.backgroundColor] = UIColor(fill.color)
                }
            case "link", "href":
                attrs[.foregroundColor] = UIColor(Tokens.Text.tint.color)
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            default: break
            }
        }
        if !traits.isEmpty, let descriptor = font.fontDescriptor.withSymbolicTraits(
            font.fontDescriptor.symbolicTraits.union(traits)
        ) {
            font = UIFont(descriptor: descriptor, size: font.pointSize)
        }
        attrs[.font] = font
        attrs[.memryMarks] = run.marks
        return attrs
    }

    /// One inline node, drawn as the chip its label reads as.
    private static func chip(_ segment: Segment, style: Style) -> NSAttributedString {
        let run = segment.run
        if run.marks.contains("hashTag") { return tagPill(segment, style: style) }
        let label = NoteInlineLabel.text(of: run)
        var ink = UIColor(Tokens.Text.tint.color)
        var font = style.font
        if run.marks.contains("wikiLink") {
            let target = run.markAttrs["wikiLink.target"] ?? run.target
            if let target, style.titleExists?(target) == false {
                ink = UIColor(Tokens.Text.secondary.color)
            } else if let bold = font.fontDescriptor.withSymbolicTraits(.traitBold) {
                font = UIFont(descriptor: bold, size: font.pointSize)
            }
        } else if run.marks.contains("dateMention") {
            ink = NoteInline.isReminding(run)
                ? UIColor((Tokens.Content.ink(named: "blue") ?? Tokens.Text.tint).color)
                : UIColor(Tokens.Text.secondary.color)
        } else if run.marks.contains("linkMention") {
            ink = UIColor(Tokens.Text.secondary.color)
        }
        let shown = run.marks.contains("dateMention") ? "@" + label : (label.isEmpty ? "\u{25A1}" : label)
        let text = NSAttributedString(string: shown, attributes: [.font: font, .foregroundColor: ink])
        let size = text.size()
        let image = UIGraphicsImageRenderer(size: CGSize(width: ceil(size.width), height: ceil(size.height)))
            .image { _ in text.draw(at: .zero) }
        let attachment = NSTextAttachment(image: image)
        attachment.bounds = CGRect(x: 0, y: font.descender, width: image.size.width, height: image.size.height)
        attachment.accessibilityLabel = shown
        let out = NSMutableAttributedString(attachment: attachment)
        out.addAttributes(
            [.font: style.font, .memryNodeBytes: segment.coreBytes, .memryMarks: [String]()],
            range: NSRange(location: 0, length: out.length)
        )
        if run.marks.contains("wikiLink"), let target = run.markAttrs["wikiLink.target"] ?? run.target {
            out.addAttribute(.memryWikiTarget, value: target, range: NSRange(location: 0, length: out.length))
        }
        if run.marks.contains("dateMention"), let date = DateMentionChip.from(run) {
            out.addAttribute(.memryDate, value: date, range: NSRange(location: 0, length: out.length))
        }
        return out
    }

    /// Desktop's `inline-hash-tag`: `#tag` at 0.9em medium in the tag's
    /// colour, on a 12% fill of it, 8pt across and fully rounded.
    private static func tagPill(_ segment: Segment, style: Style) -> NSAttributedString {
        let run = segment.run
        let name = NoteInline.tagName(of: run)
        let ink = UIColor(NoteInline.tagColor(of: run, colors: style.tagColors))
        let shown = "#" + name
        let font = UIFont.systemFont(ofSize: style.font.pointSize * 0.9, weight: .medium)
        let text = NSAttributedString(string: shown, attributes: [.font: font, .foregroundColor: ink])
        let textSize = text.size()
        let padX: CGFloat = 8
        let padY: CGFloat = 1
        let size = CGSize(width: ceil(textSize.width + padX * 2), height: ceil(textSize.height + padY * 2))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            ink.withAlphaComponent(Tokens.Palette.chipFillAlpha).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: min(10, size.height / 2)).fill()
            text.draw(at: CGPoint(x: padX, y: padY))
        }
        let attachment = NSTextAttachment(image: image)
        // Centre the pill on the line's x-height, as desktop's inline box sits.
        let y = (style.font.capHeight - size.height) / 2
        attachment.bounds = CGRect(x: 0, y: y, width: size.width, height: size.height)
        attachment.accessibilityLabel = shown
        let out = NSMutableAttributedString(attachment: attachment)
        out.addAttributes(
            [.font: style.font, .memryNodeBytes: segment.coreBytes, .memryMarks: [String](), .memryTag: name],
            range: NSRange(location: 0, length: out.length)
        )
        return out
    }
}

/// Where a pane puts an inline node: at the space it wrote at UTF-16
/// `location` in `typed`, its text once its commit landed, either over
/// that space (`replaces`, a date chip's update) or just before it (a
/// menu's node, an append). Another pane's write may land before the node
/// does and move that space (#4706), so the node goes where the block holds
/// it then.
struct NodeAnchor: Sendable, Equatable {
    let typed: String
    let location: Int
    let replaces: Bool
    /// The core range in the pane's own text, for a surface that reads no
    /// block (the journal): it holds only this pane's text.
    let paneRange: Range<Int>

    /// The anchor at `location` in `text`, the pane's text view's text.
    @MainActor static func at(_ location: Int, in text: NSAttributedString, replaces: Bool) -> NodeAnchor {
        let start = BlockText.coreOffset(in: text, utf16: location)
        return NodeAnchor(typed: text.string, location: location, replaces: replaces, paneRange: start ..< start + (replaces ? 1 : 0))
    }

    static let moved = UserFacingError(
        code: "editor.nodeMoved",
        title: "The text around it changed in another pane, so it went at the end of the paragraph.",
        guidance: "Nothing was lost. Move it where you want it.",
        recourse: .blocked,
        isUserVisible: true
    )

    /// The core range the node goes over in `runs`, the block as the core
    /// holds it: the pane's space carried past what changed since, or found
    /// by the text on both sides of it. `nil` when neither finds it, so a
    /// ranged insert never replaces another writer's text.
    func range(in runs: [InlineRun]?) -> Range<Int>? {
        guard let runs else { return paneRange }
        guard let at = location(in: BlockText.shown(runs)) else { return nil }
        let start = BlockText.coreOffset(in: runs, shown: at)
        return start ..< start + (replaces ? 1 : 0)
    }

    /// The pane's space, in UTF-16 of `live`, the block's text as the core
    /// holds it (`range(in:)`).
    func location(in live: String) -> Int? {
        BlockText.follow(location, length: 1, from: typed, to: live) ?? found(in: live)
    }

    /// The space in `live` by its context: the widest window of `typed`
    /// around it, as wide on each side (cut at `typed`'s ends), that `live`
    /// holds exactly once. Another pane's edits on both sides of the space
    /// leave the text next to it. A window held twice is ambiguous, and so
    /// is every narrower one.
    private func found(in live: String) -> Int? {
        let typed = typed as NSString
        let live = live as NSString
        for width in stride(from: max(location, typed.length - location - 1), through: 1, by: -1) {
            let lower = max(0, location - width)
            let window = typed.substring(with: NSRange(location: lower, length: min(typed.length, location + 1 + width) - lower))
            let first = live.range(of: window, options: .literal)
            guard first.location != NSNotFound else { continue }
            let rest = NSRange(location: first.location + 1, length: live.length - first.location - 1)
            guard live.range(of: window, options: .literal, range: rest).location == NSNotFound else { return nil }
            return first.location + location - lower
        }
        return nil
    }

    /// The end of the block's last run of text, in core bytes: where a
    /// node whose place is gone goes, as an insert needs a text run.
    static func textEnd(in runs: [InlineRun]?) -> Int? {
        guard let runs else { return nil }
        var bytes = 0
        var end: Int?
        for segment in BlockText.segments(runs) {
            bytes += segment.coreBytes
            if !segment.isNode, !segment.text.isEmpty { end = bytes }
        }
        return end
    }
}
