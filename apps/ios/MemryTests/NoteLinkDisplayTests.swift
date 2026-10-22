import MemryCore
import Testing

@testable import Memry

// #2845: which paragraphs draw a link card, and what the card reads.

@Suite("Note link display")
struct NoteLinkDisplayTests {
    private func link(_ target: String, _ attrs: [String: String] = [:]) -> InlineRun {
        InlineRun(
            text: "", marks: ["wikiLink"],
            markAttrs: attrs.merging(["wikiLink.target": target]) { $1 }, target: nil
        )
    }

    private func text(_ value: String) -> InlineRun {
        InlineRun(text: value, marks: [], markAttrs: [:], target: nil)
    }

    private func paragraph(_ runs: [InlineRun], kind: String = "paragraph") -> Block {
        Block(id: "b", kind: kind, depth: 0, props: [], inline: runs)
    }

    @Test("size, cover and preview are read from the node's attributes")
    func parsesAttributes() {
        let run = link("Dune", ["wikiLink.size": "medium", "wikiLink.cover": "true", "wikiLink.preview": "1"])
        #expect(NoteLinkDisplay(run) == NoteLinkDisplay(size: .medium, cover: true, preview: true))
    }

    @Test("absent or unknown attributes mean today's chip")
    func defaults() {
        #expect(NoteLinkDisplay(link("Dune")) == NoteLinkDisplay())
        let odd = link("Dune", ["wikiLink.size": "huge", "wikiLink.cover": "no"])
        #expect(NoteLinkDisplay(odd) == NoteLinkDisplay())
    }

    @Test("a link alone on its line with a size is a card")
    func soleLinkIsACard() throws {
        let card = try #require(NoteLinkDisplay.card(in: paragraph([link("Dune", ["wikiLink.size": "small"])])))
        #expect(card.target == "Dune")
        #expect(card.title == "Dune")
        #expect(card.isBoxed)
    }

    @Test("whitespace around the only link does not stop it being alone")
    func whitespaceIsIgnored() {
        let runs = [text(" "), link("Dune", ["wikiLink.size": "medium"]), text("")]
        #expect(NoteLinkDisplay.card(in: paragraph(runs)) != nil)
    }

    @Test("a link inside running text stays a chip whatever its size")
    func inlineLinkIgnoresSize() {
        let runs = [text("see "), link("Dune", ["wikiLink.size": "medium", "wikiLink.preview": "true"])]
        #expect(NoteLinkDisplay.card(in: paragraph(runs)) == nil)
    }

    @Test("a plain chip, and a link outside a paragraph, are not cards")
    func nothingToAdd() {
        #expect(NoteLinkDisplay.card(in: paragraph([link("Dune")])) == nil)
        let sized = link("Dune", ["wikiLink.size": "small"])
        #expect(NoteLinkDisplay.card(in: paragraph([sized], kind: "heading")) == nil)
    }

    @Test("a chip with a preview is not boxed but still has something to draw")
    func chipWithPreview() throws {
        let card = try #require(NoteLinkDisplay.card(in: paragraph([link("Dune", ["wikiLink.preview": "true"])])))
        #expect(!card.isBoxed)
    }

    @Test("the description property wins when it is a non-empty string")
    func descriptionProperty() {
        func prop(_ json: String) -> [NoteProperty] {
            [NoteProperty(name: "description", valueJson: json, typeName: nil, optionsJson: nil, color: nil)]
        }
        #expect(NoteLinkPreview.description(in: prop(#""A desert planet""#)) == "A desert planet")
        #expect(NoteLinkPreview.description(in: prop(#""  ""#)) == nil)
        #expect(NoteLinkPreview.description(in: prop("42")) == nil)
        #expect(NoteLinkPreview.description(in: []) == nil)
    }

    @Test("the body snippet drops preview markers and keeps the first lines")
    func bodySnippet() {
        let body = "# Dune\n\n- spice\nThe sleeper must awaken\nfourth line"
        #expect(NoteLinkPreview.snippet(ofBody: body) == "Dune spice The sleeper must awaken")
        #expect(NoteLinkPreview.snippet(ofBody: "\n  \n") == nil)
    }
}
