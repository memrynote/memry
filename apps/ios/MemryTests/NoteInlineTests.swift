import Foundation
import MemryCore
import SwiftUI
import Testing

@testable import Memry

// Inline runs to attributed text, and the wiki-link URL they travel under.
//
// Asserted over values rather than through a rendered view: a snapshot of a
// `Text` would tell us a link is blue, not that it points at the right note.

@Suite("Note inline")
struct NoteInlineTests {
    private func run(
        _ text: String,
        marks: [String] = [],
        markAttrs: [String: String] = [:],
        target: String? = nil
    ) -> InlineRun {
        InlineRun(text: text, marks: marks, markAttrs: markAttrs, target: target)
    }

    /// A concrete colour, for comparison.
    ///
    /// `AdaptiveColor.color` wraps a **dynamic** `UIColor` built fresh on
    /// every call, so two reads of one token are never `==` and neither are
    /// two uncoloured runs. Resolving against a fixed interface style is what
    /// turns "is this the ordinary ink" into a question with an answer.
    private func resolved(_ color: Color?) -> UIColor? {
        guard let color else { return nil }
        return UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
    }

    @Test("a colour mark paints the run the colour it names")
    func colourMarksArePainted() {
        // The defect this closes: the core sent the mark's NAME and not its
        // value, so `textColor=red` and `textColor=blue` arrived identical
        // and neither was painted at all.
        let red = NoteInline.attributed(
            run("warning", marks: ["textColor"], markAttrs: ["textColor": "red"])
        )
        let blue = NoteInline.attributed(
            run("warning", marks: ["textColor"], markAttrs: ["textColor": "blue"])
        )

        #expect(resolved(red.foregroundColor) != nil)
        #expect(
            resolved(red.foregroundColor) != resolved(blue.foregroundColor),
            "two colours must not render alike"
        )
    }

    @Test("an unknown colour name leaves the text in the ordinary ink")
    func unknownColoursAreNotGuessed() {
        // A colour a later schema adds. Painting it something arbitrary is
        // worse than not painting it.
        let piece = NoteInline.attributed(
            run("text", marks: ["textColor"], markAttrs: ["textColor": "chartreuse"])
        )
        // Against a run carrying no colour at all rather than against the
        // token: `AdaptiveColor.color` builds a fresh dynamic `UIColor` on
        // every call, so two reads of one token are never `==`. What matters
        // is that an unknown name renders like no name.
        let plain = NoteInline.attributed(run("text"))

        #expect(resolved(piece.foregroundColor) == resolved(plain.foregroundColor))
        #expect(String(piece.characters) == "text")
    }

    @Test("an inline checkbox draws a box rather than nothing")
    func inlineCheckboxIsVisible() {
        // It arrives as an empty run carrying the mark, because a table cell
        // cannot hold a block (chapter 12 §12.7.1). Before this it drew as
        // zero characters.
        let checked = NoteInline.attributed(
            run("", marks: ["inlineCheckbox"], markAttrs: ["inlineCheckbox.checked": "true"])
        )
        let unchecked = NoteInline.attributed(run("", marks: ["inlineCheckbox"]))

        #expect(!String(checked.characters).isEmpty)
        #expect(String(checked.characters) != String(unchecked.characters))
    }

    @Test("a wiki link becomes a link the platform can hit")
    func wikiLinkBecomesALink() throws {
        // A link rather than a tap gesture, because a link is what VoiceOver's
        // rotor lists and what the platform draws a hit area for.
        let piece = NoteInline.attributed(run("Dune", marks: ["wikiLink"], target: "Dune Messiah"))
        let url = try #require(piece.link)

        #expect(NoteInline.wikiTarget(of: url) == "Dune Messiah")
    }

    @Test("a title with spaces, slashes and a hash survives the round trip")
    func awkwardTitlesSurvive() throws {
        // A note title is free text. Read as host-and-path, `a/b #c` loses
        // everything after the slash and the fragment, and the link resolves
        // against a title nobody wrote.
        let title = "Recipes/2026 #draft & co"
        let url = try #require(NoteInline.wikiURL(for: title))

        #expect(NoteInline.wikiTarget(of: url) == title)
    }

    @Test("a wiki link with no target is styled but not linked")
    func noTargetNoLink() {
        // Nowhere to go: it still reads as a link in the sentence, and it
        // does not offer a tap that resolves to nothing.
        let piece = NoteInline.attributed(run("Dune", marks: ["wikiLink"]))

        #expect(piece.link == nil)
    }

    @Test("a tag links to its own screen, carrying the name without the hash")
    func tagsAreLinks() throws {
        // N600 built the screen that was missing, so the tag is a link now.
        // The `#` belongs to the text, not to the tag's name, and the name is
        // what the core matches on.
        let piece = NoteInline.attributed(run("#reading", marks: ["hashTag"], target: "reading"))

        let link = try #require(piece.link)
        #expect(link.scheme == NoteInline.tagScheme)
        #expect(NoteInline.tagTarget(of: link) == "reading")
    }

    @Test("a date mention is still marked and never linked")
    func dateMentionsAreNotLinks() {
        // Unchanged by N600: this build has no calendar to open, and a word
        // that looks tappable and does nothing is worse than one that does
        // not.
        let piece = NoteInline.attributed(
            run("tomorrow", marks: ["dateMention"], target: "2026-09-23")
        )

        #expect(piece.link == nil)
    }

    @Test("an unknown mark keeps the text")
    func unknownMarksKeepTheText() {
        // Losing a word to a mark this build has never heard of is the failure
        // the whole block path exists to avoid; losing the emphasis is not.
        let piece = NoteInline.attributed(run("still here", marks: ["sparkle"]))

        #expect(String(piece.characters) == "still here")
    }

    @Test("a web link is handed to the system, not to the note router")
    func webLinksStaySystemLinks() throws {
        let piece = NoteInline.attributed(
            run("docs", marks: ["link"], target: "https://example.com/a")
        )
        let url = try #require(piece.link)

        #expect(url.scheme == "https")
        #expect(NoteInline.wikiTarget(of: url) == nil, "the note router must not claim a web link")
    }
}
