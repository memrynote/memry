import Foundation
import MemryCore
import SwiftUI

/// Runs to attributed text. A free function so the mapping is asserted over
/// values rather than through a rendered view.
enum NoteInline {
    /// The scheme a wiki link is carried under.
    ///
    /// A link rather than a tap gesture because a link is what the platform
    /// understands: it draws it, hits it, and lists it in VoiceOver's link
    /// rotor. The scheme is private to this app and never leaves it — the
    /// handler above resolves it and hands the system nothing.
    static let wikiScheme = "memry-wiki"

    /// The title a wiki-link URL carries, or `nil` for any other URL.
    static func wikiTarget(of url: URL) -> String? {
        guard url.scheme == wikiScheme else { return nil }
        // The whole tail, percent-decoded: a note title is free text and can
        // hold slashes, spaces and `#`, none of which survive being read as
        // host-and-path.
        let raw = url.absoluteString.dropFirst("\(wikiScheme)://".count)
        return raw.removingPercentEncoding.map { $0 } ?? String(raw)
    }

    /// The scheme a tappable inline checkbox is carried under (N605).
    ///
    /// A link, like a tag, because that is the affordance the platform
    /// already draws, hits and lists for VoiceOver. The URL carries the
    /// checkbox's ordinal **within its cell**, which is how the core
    /// addresses it: an inline checkbox has no id (§12.7.1).
    static let checkboxScheme = "memry-check"

    static func checkboxTarget(of url: URL) -> Int? {
        guard url.scheme == checkboxScheme else { return nil }
        return Int(url.absoluteString.dropFirst("\(checkboxScheme)://".count))
    }

    static func checkboxURL(ordinal: Int) -> URL? {
        URL(string: "\(checkboxScheme)://\(ordinal)")
    }

    /// The scheme a `#tag` is carried under (N600).
    ///
    /// Its own scheme rather than reusing the wiki one: a tag and a note
    /// title are different destinations, and a handler that had to guess
    /// which it was holding would guess wrong on a note actually titled like
    /// a tag.
    static let tagScheme = "memry-tag"

    /// The tag a tag URL carries, or `nil` for any other URL.
    static func tagTarget(of url: URL) -> String? {
        guard url.scheme == tagScheme else { return nil }
        let raw = url.absoluteString.dropFirst("\(tagScheme)://".count)
        return raw.removingPercentEncoding.map { $0 } ?? String(raw)
    }

    static func tagURL(for tag: String) -> URL? {
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let encoded = trimmed.addingPercentEncoding(
                  withAllowedCharacters: .alphanumerics
              )
        else { return nil }
        return URL(string: "\(tagScheme)://\(encoded)")
    }

    /// A wiki link's URL, or `nil` when there is no target to point at.
    static func wikiURL(for target: String) -> URL? {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let encoded = trimmed.addingPercentEncoding(
                  withAllowedCharacters: .alphanumerics
              )
        else { return nil }
        return URL(string: "\(wikiScheme)://\(encoded)")
    }

    /// A checkbox glyph, tappable only where a cell handed it an ordinal.
    ///
    /// A table cell cannot hold a block, so a checkbox inside one is an
    /// inline node carrying no text (§12.7.1): it arrives as an empty run and
    /// would otherwise draw as nothing. Outside a cell there is nothing to
    /// address it with, and a box that looks tappable and does nothing is
    /// worse than one that does not.
    static func checkbox(_ run: InlineRun, ordinal: Int?) -> AttributedString {
        let ticked = run.markAttrs["inlineCheckbox.checked"] == "true"
        var glyph = AttributedString(ticked ? "\u{2611}" : "\u{2610}")
        if let ordinal {
            glyph.link = checkboxURL(ordinal: ordinal)
        }
        return glyph
    }

    /// Whether a date mention carries a reminder. `none`, an absent value and
    /// the legacy boolean `false` all mean it does not.
    static func isReminding(_ run: InlineRun) -> Bool {
        let remind = run.markAttrs["dateMention.remind"] ?? "none"
        return !["none", "", "false"].contains(remind)
    }

    /// A tag's name, which is its text without the `#` that displays it.
    static func tagName(of run: InlineRun) -> String {
        let text = NoteInlineLabel.text(of: run)
        return text.hasPrefix("#") ? String(text.dropFirst()) : text
    }

    /// One run as attributed text.
    ///
    /// **A run sets a font or an ink only when one of its marks says so.**
    /// Everything else is inherited from the view drawing it, because an
    /// `AttributedString` attribute beats the view's modifier: a run that
    /// always set the body font made every heading body-sized, and one that
    /// always set the primary ink hid a quote's secondary ink and a block's
    /// own `textColor`. `base` is the font a bold or italic mark builds on,
    /// so a bold word in a heading stays heading-sized.
    static func attributed(
        _ run: InlineRun,
        checkboxOrdinal: Int? = nil,
        base: Font? = nil,
        titleExists: ((String) -> Bool)? = nil
    ) -> AttributedString {
        var style = RunStyle(
            piece: AttributedString(label(of: run)),
            baseFont: base ?? Tokens.Typography.body.font
        )
        for mark in run.marks where !style.applyText(mark, run) {
            style.applyNode(mark, run, checkboxOrdinal: checkboxOrdinal, titleExists: titleExists)
        }
        if let font = style.font {
            style.piece.font = font
        }
        return style.piece
    }

    /// The words a run shows. Desktop's pill spelling for a date: `@` before
    /// it, and an alarm after one that reminds, with a text presentation
    /// selector so the glyph draws in the run's ink rather than as an emoji.
    private static func label(of run: InlineRun) -> String {
        let text = NoteInlineLabel.text(of: run)
        guard run.marks.contains("dateMention"), run.text.isEmpty else { return text }
        return "@" + text + (isReminding(run) ? " \u{23F0}\u{FE0E}" : "")
    }
}

/// One run's attributes while its marks are applied.
private struct RunStyle {
    var piece: AttributedString
    let baseFont: Font
    var font: Font?

    /// The text styles. `false` when `mark` is not one of them.
    mutating func applyText(_ mark: String, _ run: InlineRun) -> Bool {
        switch mark {
        case "bold": font = (font ?? baseFont).bold()
        case "italic": font = (font ?? baseFont).italic()
        case "code": font = Tokens.Typography.recoveryMaterial.font
        case "strike": piece.strikethroughStyle = .single
        case "underline": piece.underlineStyle = .single
        case "textColor":
            // The name is not the value: an unknown name leaves the text in
            // the ordinary ink rather than guessing.
            if let name = run.markAttrs[mark], let ink = Tokens.Content.ink(named: name) {
                piece.foregroundColor = ink.color
            }
        case "backgroundColor":
            if let name = run.markAttrs[mark], let fill = Tokens.Content.fill(named: name) {
                piece.backgroundColor = fill.color
            }
        default:
            return false
        }
        return true
    }

    /// The inline nodes and links. An unknown mark leaves the text alone:
    /// losing a word to a mark nobody taught this build is the failure,
    /// losing the emphasis is not.
    mutating func applyNode(
        _ mark: String,
        _ run: InlineRun,
        checkboxOrdinal: Int?,
        titleExists: ((String) -> Bool)?
    ) {
        switch mark {
        case "inlineCheckbox":
            piece.append(NoteInline.checkbox(run, ordinal: checkboxOrdinal))
        case "wikiLink":
            applyWikiLink(run, titleExists: titleExists)
        case "linkMention":
            // A web page, as desktop's quiet chip, opened by the system. It
            // was routed as a wiki link before, which pushed a "no note
            // called github.com" notice.
            piece.foregroundColor = Tokens.Text.secondary.color
            piece.backgroundColor = Tokens.Canvas.surface.color
            piece.link = (run.markAttrs["linkMention.url"] ?? run.target).flatMap(URL.init(string:))
        case "link", "href":
            piece.foregroundColor = Tokens.Text.tint.color
            piece.underlineStyle = .single
            piece.link = run.target.flatMap(URL.init(string:))
        case "hashTag":
            piece.foregroundColor = Tokens.Text.tint.color
            piece.link = NoteInline.tagURL(for: NoteInline.tagName(of: run))
        case "dateMention":
            // Not linked: this build has no calendar to open. Muted like
            // desktop's pill, and blue when it reminds.
            piece.foregroundColor = NoteInline.isReminding(run)
                ? (Tokens.Content.ink(named: "blue") ?? Tokens.Text.tint).color
                : Tokens.Text.secondary.color
        default:
            break
        }
    }

    /// Desktop's wiki link: the accent, semibold, no underline. A link whose
    /// title names no note here is muted with a dashed underline, as desktop
    /// draws it, so a reader sees it leads nowhere before tapping. Resolved
    /// on the tap, not here: a query per link to draw one screen is waste.
    private mutating func applyWikiLink(_ run: InlineRun, titleExists: ((String) -> Bool)?) {
        let target = run.markAttrs["wikiLink.target"] ?? run.target
        if let target, titleExists?(target) == false {
            piece.foregroundColor = Tokens.Text.secondary.color
            piece.underlineStyle = .single.union(.patternDash)
        } else {
            piece.foregroundColor = Tokens.Text.tint.color
            font = (font ?? baseFont).weight(.semibold)
        }
        piece.link = target.flatMap(NoteInline.wikiURL(for:))
    }
}
