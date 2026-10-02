//
//  InlineTagSyncTests.swift
//  A `#tag` in the body is one of the note's tags, as on desktop.
//

import MemryCore
@testable import Memry
import Testing

@MainActor
@Suite("Inline tag sync")
struct InlineTagSyncTests {
    private func block(_ kind: String = "paragraph", _ inline: [InlineRun]) -> Block {
        Block(id: kind, kind: kind, depth: 0, props: [], inline: inline)
    }

    private func text(_ text: String) -> InlineRun {
        InlineRun(text: text, marks: [], markAttrs: [:], target: nil)
    }

    @Test("typed tags and tag nodes are read, once each, and code is not")
    func readsTheBody() {
        let blocks = [
            block("paragraph", [text("read #Books and #books"), InlineRun(text: "#work", marks: ["hashTag"], markAttrs: [:], target: "work")]),
            block("codeBlock", [text("#notatag")]),
        ]

        #expect(InlineTagSync.tags(in: blocks) == ["Books", "work"])
    }

    @Test("a typed tag joins the note, a deleted one leaves, a row tag stays")
    func followsTheBody() {
        let added = InlineTagSync.next(noteTags: ["manual"], previous: [], current: ["exampletag"])
        #expect(added == ["manual", "exampletag"])

        let removed = InlineTagSync.next(noteTags: ["manual", "exampletag"], previous: ["exampletag"], current: [])
        #expect(removed == ["manual"])

        #expect(InlineTagSync.next(noteTags: ["Work"], previous: [], current: ["work"]) == nil)
    }
}
