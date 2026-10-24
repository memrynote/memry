//
//  UnlinkedMentionsTests.swift
//  #3330: the unlinked mentions list and its Link action, through the real
//  core: the list the core answers, the block the shell finds, the wiki link
//  the edit writes.
//

import Foundation
import MemryCore
import Testing

@testable import Memry

@Suite("Unlinked mentions", .serialized)
@MainActor
struct UnlinkedMentionsTests {
    private struct Fixture {
        let vault: TasksTestVault
        let target: String
        let source: String
        let model: UnlinkedMentionsViewModel
        let reader: CoreNotesReader
        let search: CoreVaultSearch
    }

    private func fixture(_ body: String) throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let target = try writer.create(title: "Agent Dune", folderPath: nil)
        let source = try writer.create(title: "Reading", folderPath: nil)
        _ = try writer.editBlock(
            noteId: source,
            edit: .insertBlock(
                kind: "paragraph", afterBlockId: nil, text: body,
                newBlockId: UUID().uuidString.lowercased()
            )
        )
        let search = try CoreVaultSearch(vault: vault.vault, executor: .shared)
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = UnlinkedMentionsViewModel(noteId: target, search: search, reader: reader, editor: editor)
        return Fixture(vault: vault, target: target, source: source, model: model, reader: reader, search: search)
    }

    private func rows(_ model: UnlinkedMentionsViewModel) -> [UnlinkedMention] {
        guard case let .ready(rows) = model.phase else {
            Issue.record("unlinked mentions did not load: \(model.phase)")
            return []
        }
        return rows
    }

    @Test func the_list_names_each_mention_as_written() async throws {
        let f = try fixture("I like agent dune. Also Agent Dune! But not Agent Dunes.")

        await f.model.toggle()

        let list = rows(f.model)
        #expect(list.map(\.sourceId) == [f.source])
        #expect(list.first?.mentions == ["agent dune", "Agent Dune"])
    }

    @Test func link_turns_the_chosen_mention_into_a_wiki_link_with_its_text_as_alias() async throws {
        let f = try fixture("I like agent dune. Also Agent Dune!")
        await f.model.toggle()
        let source = try #require(rows(f.model).first)

        let landed = await f.model.link(source, index: 1, targetTitle: "Agent Dune")

        #expect(landed)
        let blocks = try #require(try await f.reader.blocks(id: f.source))
        let runs = blocks.flatMap(\.inline)
        let links = runs.filter { $0.marks.contains("wikiLink") }
        #expect(links.count == 1)
        #expect(links.first?.target == "Agent Dune")
        // The other mention stays plain text, and the list shrinks to it.
        #expect(runs.filter { !$0.marks.contains("wikiLink") }.map(\.text).joined().contains("agent dune"))
        #expect(rows(f.model).isEmpty)
    }

    @Test func a_mention_edited_away_is_refused_not_linked_elsewhere() async throws {
        let f = try fixture("I like agent dune.")
        await f.model.toggle()
        let stale = try #require(rows(f.model).first)
        let blocks = try #require(try await f.reader.blocks(id: f.source))
        let writer = try f.vault.vault.notesWriter(store: TaskTestKeychain())
        _ = try writer.editBlock(
            noteId: f.source,
            edit: .setText(blockId: try #require(blocks.first?.id), text: "Nothing to see here.")
        )

        let landed = await f.model.link(stale, index: 0, targetTitle: "Agent Dune")

        #expect(!landed)
        #expect(f.model.mentionChanged)
        let after = try #require(try await f.reader.blocks(id: f.source))
        #expect(after.flatMap(\.inline).allSatisfy { !$0.marks.contains("wikiLink") })
    }

    @Test func the_locator_counts_whole_words_and_skips_nodes() {
        let text = InlineRun(text: "Dune and Dunes and dune ", marks: [], markAttrs: [:], target: nil)
        let node = InlineRun(text: "", marks: ["wikiLink"], markAttrs: [:], target: "Dune")
        let tail = InlineRun(text: "Dune", marks: ["bold"], markAttrs: [:], target: nil)
        let block = Block(id: "b1", kind: "paragraph", depth: 0, props: [], inline: [text, node, tail])

        let spots = UnlinkedMentionLocator.spots(of: "Dune", in: [block])

        #expect(spots == [
            .init(blockId: "b1", start: 0, end: 4),
            .init(blockId: "b1", start: 24, end: 28),
        ])
    }
}
