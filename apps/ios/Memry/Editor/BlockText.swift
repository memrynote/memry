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
}

@MainActor
enum BlockText {
    static let placeholder = "\u{FFFC}"

    /// BlockNote's inline nodes, which the core carries as elements.
    static let nodeKinds: Set<String> = [
        "wikiLink", "hashTag", "dateMention", "linkMention", "inlineImage", "inlineCheckbox",
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
        return out
    }
}
