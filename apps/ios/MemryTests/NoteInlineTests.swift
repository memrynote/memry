import Foundation
import MemryCore
import Testing

@testable import Memry

// Inline runs to attributed text, and the wiki-link URL they travel under.
//
// Asserted over values rather than through a rendered view: a snapshot of a
// `Text` would tell us a link is blue, not that it points at the right note.

@Suite("Note inline")
struct NoteInlineTests {
    private func run(_ text: String, marks: [String] = [], target: String? = nil) -> InlineRun {
        InlineRun(text: text, marks: marks, target: target)
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

    @Test("a tag is marked but never linked")
    func tagsAreNotLinks() {
        // There is no tag screen in this build. A word that looks tappable and
        // does nothing is worse than a word that does not.
        let piece = NoteInline.attributed(run("#reading", marks: ["hashTag"], target: "reading"))

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
