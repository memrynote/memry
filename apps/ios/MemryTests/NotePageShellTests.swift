//
//  NotePageShellTests.swift
//  N801 — searching inside a note, over the blocks already on screen.
//

import Foundation
import MemryCore
import Testing

@testable import Memry

private func run(_ text: String) -> InlineRun {
    InlineRun(text: text, marks: [], markAttrs: [:], target: nil)
}

private func block(_ id: String?, _ text: String) -> Block {
    Block(id: id, kind: "paragraph", depth: 0, props: [], inline: [run(text)])
}

@Suite("N801 find in note")
struct NoteFindTests {

    @Test func a_query_finds_the_blocks_that_contain_it() {
        let blocks = [
            block("a", "The kitchen sink"),
            block("b", "Something else"),
            block("c", "Another kitchen"),
        ]

        let matches = NoteFind.matches(of: "kitchen", in: blocks)

        #expect(matches.map(\.blockId) == ["a", "c"])
        // The index is what lets a caller scroll to the block.
        #expect(matches.map(\.blockIndex) == [0, 2])
    }

    /// Case-insensitive, because a reader looking for "kitchen" means the
    /// sentence that starts with one.
    @Test func the_search_ignores_case() {
        let blocks = [block("a", "The Kitchen Sink")]
        #expect(NoteFind.matches(of: "kitchen", in: blocks).count == 1)
        #expect(NoteFind.matches(of: "KITCHEN", in: blocks).count == 1)
    }

    /// **An empty query matches nothing, not everything.** "No search" and
    /// "every block matched" are different answers and must not render the
    /// same.
    @Test func an_empty_query_matches_nothing() {
        let blocks = [block("a", "anything"), block("b", "at all")]
        #expect(NoteFind.matches(of: "", in: blocks).isEmpty)
        #expect(NoteFind.matches(of: "   ", in: blocks).isEmpty)
    }

    @Test func a_query_nothing_contains_finds_nothing() {
        let blocks = [block("a", "the kitchen sink")]
        #expect(NoteFind.matches(of: "bathroom", in: blocks).isEmpty)
    }

    /// The whole line comes back, because the result row shows the sentence
    /// rather than the word.
    @Test func a_match_carries_the_line_it_sits_in() {
        let blocks = [block("a", "The kitchen sink is full")]
        #expect(NoteFind.matches(of: "sink", in: blocks).first?.line == "The kitchen sink is full")
    }

    /// A block with no id still matches and is still listed; it simply cannot
    /// be scrolled to, which the view disables rather than hides.
    @Test func a_block_with_no_id_still_matches() {
        let blocks = [block(nil, "kitchen")]
        let matches = NoteFind.matches(of: "kitchen", in: blocks)
        #expect(matches.count == 1)
        #expect(matches[0].blockId == nil)
    }

    /// A block's text is its runs joined, so a match spanning formatting is
    /// still found: "the **kitchen** sink" is one line to a reader.
    @Test func a_match_spanning_formatted_runs_is_still_found() {
        let split = Block(
            id: "a",
            kind: "paragraph",
            depth: 0,
            props: [],
            inline: [run("The kit"), run("chen sink")]
        )
        #expect(NoteFind.matches(of: "kitchen", in: [split]).count == 1)
    }
}
