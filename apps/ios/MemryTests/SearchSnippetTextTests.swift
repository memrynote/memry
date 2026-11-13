import MemryCore
import SwiftUI
import Testing

@testable import Memry

// #4316: the snippet line under a search hit. The segments are the core's and
// pinned in Rust; these assert what the line draws from them.

@MainActor
@Suite("Search snippet")
struct SearchSnippetTextTests {
    @Test func the_matched_word_alone_is_semibold() throws {
        let text = try #require(SearchSnippetText.attributed([
            SnippetSegment(text: "the wifi ", highlighted: false),
            SnippetSegment(text: "password", highlighted: true),
            SnippetSegment(text: " is on the fridge", highlighted: false)
        ]))

        #expect(String(text.characters) == "the wifi password is on the fridge")
        let bold = text.runs.filter { $0.font != nil }.map { String(text[$0.range].characters) }
        #expect(bold == ["password"])
    }

    @Test func a_title_only_hit_draws_its_body_plainly() throws {
        let text = try #require(SearchSnippetText.attributed([
            SnippetSegment(text: "Nothing about it here.", highlighted: false)
        ]))

        #expect(String(text.characters) == "Nothing about it here.")
        #expect(text.runs.allSatisfy { $0.font == nil })
    }

    @Test func no_segments_draw_no_line() {
        #expect(SearchSnippetText.attributed([]) == nil)
    }
}
