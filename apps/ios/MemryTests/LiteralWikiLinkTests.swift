//
//  LiteralWikiLinkTests.swift
//  #3318: `[[...]]` typed as text in a synced body opens its note from the
//  editor, and backlinks answer on an index nothing else built.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

@Suite("Literal wiki links", .serialized)
@MainActor
struct LiteralWikiLinkTests {
    private func run(_ text: String, marks: [String] = []) -> InlineRun {
        InlineRun(text: text, marks: marks, markAttrs: [:], target: nil)
    }

    private func targets(_ text: NSAttributedString) -> [String: String] {
        var out: [String: String] = [:]
        text.enumerateAttribute(.memryWikiTarget, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let target = value as? String { out[(text.string as NSString).substring(with: range)] = target }
        }
        return out
    }

    @Test func literal_links_carry_their_target_and_code_does_not() {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label)
        let text = NSMutableAttributedString(attributedString: BlockText.attributed(
            [run("see [[Dune]] and [[Work/Plan|the plan]] "), run("[[Not a link]]", marks: ["code"])],
            style: style
        ))

        BlockText.markWikiLinks(in: text, titleExists: nil)

        #expect(targets(text) == ["[[Dune]]": "Dune", "[[Work/Plan|the plan]]": "Work/Plan"])
    }

    @Test func a_table_cells_escaped_alias_pipe_is_not_part_of_the_target() {
        #expect(WikiTarget.literals(in: #"[[Dune\|book]]"#).map(\.target) == ["Dune"])
        #expect(WikiTarget.literals(in: "[[]] [[a|]] [[ok]]").map(\.target) == ["ok"])
    }

    @Test func a_wiki_link_node_carries_its_target() {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label)
        let node = InlineRun(text: "", marks: ["wikiLink"], markAttrs: ["wikiLink.target": "Dune"], target: nil)

        let text = BlockText.attributed([run("a "), node], style: style)

        #expect(targets(text).values.sorted() == ["Dune"])
    }

    @Test func backlinks_answer_from_an_index_nothing_built() async throws {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let target = try writer.create(title: "Agent Dune", folderPath: nil)
        let source = try writer.create(title: "[agent] Reading", folderPath: nil)
        _ = try writer.editBlock(
            noteId: source,
            edit: .insertBlock(
                kind: "paragraph", afterBlockId: nil, text: "see [[Agent Dune]]",
                newBlockId: UUID().uuidString.lowercased()
            )
        )
        let search = try CoreVaultSearch(vault: vault.vault, executor: .shared)
        let model = BacklinksViewModel(noteId: target, search: search)

        await model.loadIfNeeded()

        guard case let .ready(rows) = model.phase else {
            Issue.record("backlinks did not load: \(model.phase)")
            return
        }
        #expect(rows.map(\.id) == [source])
    }
}
