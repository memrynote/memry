import Foundation
// pi-lens-ignore: SourceKit
import MemryCore
import Testing

// The `note-blocks` class, on device, through the real FFI (N106).
//
// **Why iOS is held to this and not only Rust.** The class exists because a
// self-consistency test cannot see a shared loss: the only thing holding the
// block walk was an assertion that it agreed with the *text* walk of the same
// port, and two readings of one document agree whether or not either is
// right. Dropping `divider` passed that test, and so did losing every inline
// colour value. SC-010's digest does not help either — chapter 12 §12.11
// defines it over `title + "\n" + extract_text(doc)`, so a shell can lose
// every colour, link target and table boundary and still match.
//
// So the shell that actually draws notes is measured against bytes the
// TypeScript port produced, from a corpus authored through BlockNote itself.
// Nothing here recomputes an expectation; the committed JSON is the only
// input (`test-vectors/README.md` rule 2).

@Suite("note-blocks conformance")
struct NoteBlocksConformanceTests {
    private var vectors: NoteBlocksVectors { VectorFiles.noteBlocks }

    @Test("the suite runs every case the file declares")
    func caseCountMatches() {
        #expect(vectors.cases.count == vectors.meta.caseCount)
        #expect(!vectors.cases.isEmpty, "a suite that cannot find its input must not pass")
    }

    @Test("the block walk matches the committed vectors", arguments: VectorFiles.noteBlocks.cases)
    func blockWalkMatches(_ entry: NoteBlocksVectors.BlockCase) throws {
        let blocks = try blocksFromUpdate(update: Data(hex: entry.updateHex))

        #expect(blocks.count == entry.expectedBlocks.count, "\(entry.name): \(entry.pins)")
        for (actual, expected) in zip(blocks, entry.expectedBlocks) {
            #expect(actual.id == expected.id, "\(entry.name): block id")
            #expect(actual.kind == expected.kind, "\(entry.name): block kind")
            #expect(actual.depth == expected.depth, "\(entry.name): block depth")

            #expect(
                actual.props.map(\.name) == expected.props.map(\.name),
                "\(entry.name): prop names, in the order the walk sorts them"
            )
            #expect(
                actual.props.map(\.value) == expected.props.map(\.value),
                "\(entry.name): prop values"
            )

            #expect(actual.inline.count == expected.inline.count, "\(entry.name): run count")
            for (run, expectedRun) in zip(actual.inline, expected.inline) {
                #expect(run.text == expectedRun.text, "\(entry.name): run text")
                #expect(run.marks == expectedRun.marks, "\(entry.name): run marks")
                #expect(run.target == expectedRun.target, "\(entry.name): run target")
                // The whole point of the attribute map: `textColor` alone
                // cannot tell red from blue.
                #expect(run.markAttrs == expectedRun.markAttrs, "\(entry.name): mark values")
            }
        }
    }

    @Test(
        "the canonical fragment rendering matches the other ports",
        arguments: VectorFiles.noteBlocks.cases
    )
    func canonicalMatches(_ entry: NoteBlocksVectors.BlockCase) throws {
        // Documents, not update bytes: an update encodes `clientID` and
        // per-client clocks, so two ports performing the same edit
        // legitimately differ. This is the form the write class compares.
        let rendered = try canonicalFragmentFromUpdate(update: Data(hex: entry.updateHex))
        #expect(rendered == entry.expectedCanonical, "\(entry.name): \(entry.pins)")
    }

    // MARK: the specific losses this class was built to catch

    private func blocks(of name: String) throws -> [Block] {
        let entry = try #require(
            vectors.cases.first { $0.name == name },
            "the class has no case named \(name)"
        )
        return try blocksFromUpdate(update: Data(hex: entry.updateHex))
    }

    @Test("a divider reaches the shell, between its two neighbours")
    func dividerReachesTheShell() throws {
        // It used to be dropped inside the core, which made the shell's
        // `case "divider"` unreachable code.
        #expect(try blocks(of: "divider").map(\.kind) == ["paragraph", "divider", "paragraph"])
    }

    @Test("a colour mark carries its value")
    func colourMarksCarryValues() throws {
        let run = try #require(
            try blocks(of: "styles: textColor and backgroundColor").first?.inline.first
        )
        #expect(run.markAttrs["textColor"] == "red")
        #expect(run.markAttrs["backgroundColor"] == "yellow")
    }

    @Test("top-level blocks arrive at depth zero")
    func topLevelBlocksAreAtDepthZero() throws {
        // §12.5.0 makes the fragment's single top-level child a `blockGroup`.
        // A walk counting it as nesting put every top-level block at depth 1,
        // and this shell indents by depth — so the whole note drew one step in.
        for entry in vectors.cases where !entry.expectedBlocks.isEmpty {
            let depths = try blocksFromUpdate(update: Data(hex: entry.updateHex)).map(\.depth)
            #expect(depths.min() == 0, "\(entry.name) has no block at depth 0")
        }
    }

    @Test("a table keeps its rows, and the shell can address it")
    func tableKeepsItsStructure() throws {
        let blocks = try blocks(of: "table")
        let table = try #require(blocks.first)
        // The id is what the second read is keyed by.
        #expect(table.kind == "table")
        #expect(table.depth == 0)
        let blockId = try #require(table.id, "a table with no id cannot be asked for its rows")

        #expect(blocks.filter { $0.kind == "tableRow" }.count == 2)

        // And the second read the shell actually renders from.
        let entry = try #require(vectors.cases.first { $0.name == "table" })
        let content = try #require(
            try tableFromUpdate(update: Data(hex: entry.updateHex), blockId: blockId)
        )
        #expect(content.rows.count == 2, "two rows, not four loose cells")
        #expect(content.headerRows == 1)
        #expect(content.columnWidths.first == 180)
        // Q1, asserted on device too: a cell carries no blockContainer id, so
        // an edit reaches one positionally and not by id.
        #expect(content.rows.flatMap(\.cells).allSatisfy { $0.blockId == nil })
    }

    @Test("a task block carries its text as a prop, not as inline content")
    func taskBlockCarriesItsTitle() throws {
        let block = try #require(try blocks(of: "taskBlock").first)
        #expect(block.inline.isEmpty)
        #expect(block.props.first { $0.name == "title" }?.value == "A task in a note")
    }

    @Test("an empty document is an empty list, not one empty paragraph")
    func emptyDocumentIsEmpty() throws {
        #expect(try blocks(of: "an empty document").isEmpty)
    }
}
