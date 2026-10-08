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
}

@MainActor
enum BlockText {
    static let placeholder = "\u{FFFC}"

    /// BlockNote's inline nodes, which the core carries as elements.
    static let nodeKinds: Set<String> = [
        "wikiLink", "hashTag", "dateMention", "linkMention", "inlineImage", "inlineCheckbox",
        "htmlComment",
    ]

    static func isNode(_ run: InlineRun) -> Bool {
        run.marks.contains { nodeKinds.contains($0) }
    }

    /// Any mark or node: a block whose text must be written with
    /// `replaceText` rather than `setText`.
    static func isFormatted(_ runs: [InlineRun]) -> Bool {
        runs.contains { !$0.marks.isEmpty }
    }

    struct Segment: Equatable {
        let run: InlineRun
        let isNode: Bool
        /// A node with text of its own spans several runs; they collapse into
        /// one segment, as the core counts one element.
        var coreBytes: Int
        var text: String
    }

    static func segments(_ runs: [InlineRun]) -> [Segment] {
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

    private static func nodeAttrs(_ run: InlineRun) -> [String: String] {
        run.markAttrs.filter { key, _ in nodeKinds.contains { key.hasPrefix($0 + ".") } }
            .merging(["_tag": run.marks.first { nodeKinds.contains($0) } ?? ""]) { $1 }
    }

    /// The block as the text view spells it.
    static func shown(_ runs: [InlineRun]) -> String {
        segments(runs).map { $0.isNode ? placeholder : $0.text }.joined()
    }

    /// The core offset of a UTF-16 position in the text view's text.
    static func coreOffset(in text: NSAttributedString, utf16 offset: Int) -> Int {
        let end = min(max(offset, 0), text.length)
        let string = text.string as NSString
        var bytes = 0
        var index = 0
        while index < end {
            let range = string.rangeOfComposedCharacterSequence(at: index)
            let piece = string.substring(with: range)
            if piece == placeholder,
               let nodeBytes = text.attribute(.memryNodeBytes, at: index, effectiveRange: nil) as? Int {
                bytes += nodeBytes
            } else {
                bytes += piece.utf8.count
            }
            index = range.location + range.length
        }
        return bytes
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
