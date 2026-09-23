import Foundation
import MemryCore
import SwiftUI
import Testing

@testable import Memry

// What the kitchen-sink note (`notes/iOS Parity Test.md`) showed was drawn
// wrong on device, held here as values so it cannot come back quietly.

private func run(
    _ text: String,
    marks: [String] = [],
    markAttrs: [String: String] = [:],
    target: String? = nil
) -> InlineRun {
    InlineRun(text: text, marks: marks, markAttrs: markAttrs, target: target)
}

private func block(
    _ kind: String,
    depth: UInt32 = 0,
    props: [String: String] = [:],
    text: String = ""
) -> Block {
    Block(
        id: nil,
        kind: kind,
        depth: depth,
        props: props.sorted { $0.key < $1.key }.map { BlockProp(name: $0.key, value: $0.value) },
        inline: text.isEmpty ? [] : [run(text)]
    )
}

@Suite("Inline nodes carry no text and still read")
struct NoteInlineLabelTests {
    // Each of these is an atom in BlockNote's schema: the core hands it over
    // as an EMPTY run, and drawing the run's text drew "Wiki link: ." on
    // device.

    @Test("a wiki link reads as its alias, and as its title when it has none")
    func wikiLinks() {
        let aliased = run(
            "", marks: ["wikiLink"],
            markAttrs: ["wikiLink.target": "Deep Work", "wikiLink.alias": "Cal Newport book"],
            target: "Deep Work"
        )
        let bare = run(
            "", marks: ["wikiLink"],
            markAttrs: ["wikiLink.target": "Dune", "wikiLink.alias": ""],
            target: "Dune"
        )
        #expect(NoteInlineLabel.text(of: aliased) == "Cal Newport book")
        #expect(NoteInlineLabel.text(of: bare) == "Dune")
    }

    @Test("a link mention reads as the best name it stores, never blank")
    func linkMentions() {
        let domainOnly = run(
            "", marks: ["linkMention"],
            markAttrs: [
                "linkMention.url": "https://github.com/memrynote/memry",
                "linkMention.domain": "github.com",
                "linkMention.title": "",
                "linkMention.siteName": "",
            ]
        )
        #expect(NoteInlineLabel.text(of: domainOnly) == "github.com")
    }

    @Test("a full-format date reads as desktop's absolute date")
    func fullDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul") ?? .gmt
        calendar.locale = Locale(identifier: "en_GB")
        calendar.firstWeekday = 2
        let mention = run(
            "", marks: ["dateMention"],
            markAttrs: [
                "dateMention.dateISO": "2026-11-01T00:00:00.000Z",
                "dateMention.dateFormat": "full",
                "dateMention.hasTime": "false",
            ]
        )
        let label = NoteInlineLabel.dateMention(mention, now: .now, calendar: calendar)
        #expect(label.hasPrefix("1 "))
        #expect(label.hasSuffix(", 2026"))
    }

    @Test("a relative date one day out reads as Tomorrow")
    func relativeDate() throws {
        let calendar = NoteInlineLabel.desktopCalendar
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 9, day: 23, hour: 10)))
        let tomorrow = try #require(calendar.date(byAdding: .day, value: 1, to: now))
        let mention = run(
            "", marks: ["dateMention"],
            markAttrs: [
                "dateMention.dateISO": tomorrow.formatted(.iso8601),
                "dateMention.dateFormat": "relative",
                "dateMention.hasTime": "false",
            ]
        )
        #expect(NoteInlineLabel.dateMention(mention, now: now, calendar: calendar) == "Tomorrow")
    }

    @Test("a run with text of its own keeps it")
    func ownTextWins() {
        #expect(NoteInlineLabel.text(of: run("#reading", marks: ["hashTag"])) == "#reading")
    }

    @Test("a plain run sets no font and no ink, so the block's own show through")
    func plainRunsInherit() {
        // Setting the body font on every run made every heading body-sized;
        // setting the primary ink hid a block's `textColor`.
        let piece = NoteInline.attributed(run("Heading level 2"))
        #expect(piece.font == nil)
        #expect(piece.foregroundColor == nil)
    }
}

@Suite("Block list folding")
struct NoteBlockListFoldTests {
    private let blocks = [
        block("toggleListItem", props: ["open": "false"], text: "Closed"),
        block("paragraph", depth: 1, text: "Hidden"),
        block("toggleListItem", props: ["open": "true"], text: "Open"),
        block("paragraph", depth: 1, text: "Shown"),
        block("paragraph", text: "After"),
    ]

    private func texts(_ rows: [NoteBlockList.Row]) -> [String] {
        rows.map { $0.block.inline.map(\.text).joined() }
    }

    @Test("a closed toggle hides its body and an open one shows it")
    func closedHides() {
        #expect(texts(NoteBlockList.rows(of: blocks)) == ["Closed", "Open", "Shown", "After"])
    }

    @Test("flipping a toggle on screen overrides the document's state")
    func flippingOverrides() {
        let rows = NoteBlockList.rows(of: blocks, flipped: [0, 2])
        #expect(texts(rows) == ["Closed", "Hidden", "Open", "After"])
    }
}

@Suite("Property definitions and relations")
struct NotePropertyShapeTests {
    @Test("a status reads its options out of its categories, in desktop's order")
    func statusCategories() {
        let json = """
            {"categories":{"done":{"label":"Complete","options":[{"value":"done"}]},\
            "todo":{"label":"To-do","options":[{"value":"idea"},{"value":"backlog"}]},\
            "in_progress":{"label":"In progress","options":[{"value":"active"}]}}}
            """
        #expect(NotePropertyOptions.values(of: json) == ["idea", "backlog", "active", "done"])
    }

    @Test("a select still reads its flat list")
    func selectList() {
        let json = #"[{"value":"high"},{"value":"low"}]"#
        #expect(NotePropertyOptions.values(of: json) == ["high", "low"])
    }

    @Test("a list of memry URIs is a relation whatever the stored type says")
    func relationByValue() {
        let related = NoteProperty(
            name: "related",
            valueJson: #"["memry://note/6jnobxl7wd63","memry://note/c4rq76xjws56"]"#,
            typeName: "text",
            optionsJson: nil,
            color: nil
        )
        let plain = NoteProperty(
            name: "format", valueJson: #"["Kindle"]"#, typeName: "multiselect",
            optionsJson: nil, color: nil
        )
        #expect(NotePropertyKind.of(related) == .relation)
        #expect(NotePropertyKind.of(plain) == .multiselect)
    }
}
