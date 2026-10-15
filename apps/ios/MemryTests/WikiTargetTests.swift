//
//  WikiTargetTests.swift
//

import Foundation
import MemryCore
import Testing

@testable import Memry

@Suite("Wiki link targets")
@MainActor
struct WikiTargetTests {
    private static func note(_ title: String, in folder: String? = nil, names: [String] = []) -> NoteSummary {
        NoteSummary(id: "\(folder ?? "")/\(title)", title: title, folderPath: folder, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: names)
    }

    private let notes = [Self.note("Plan", in: "Work"), Self.note("plan"), Self.note("Ideas", in: "Work")]
    private let named = [Self.note("Artificial Intelligence", names: ["AI", "Yapay Zeka"]), Self.note("Reading list")]

    @Test func a_shared_title_links_by_its_path_stem_and_shows_its_folder() {
        let items = EditorSuggestions.wiki(query: "plan", notes: notes)
        #expect(items.map(\.kind) == [.note(title: "Work/Plan", alias: ""), .note(title: "/plan", alias: "")])
        #expect(items.map(\.subtitle) == ["Work", "/"])
    }

    @Test func a_unique_title_links_by_title_with_no_folder() {
        let items = EditorSuggestions.wiki(query: "ideas", notes: notes)
        #expect(items.map(\.kind) == [.note(title: "Ideas", alias: "")])
        #expect(items.first?.subtitle == nil)
    }

    @Test func the_alias_row_for_a_shared_title_carries_the_path_stem() {
        let items = EditorSuggestions.wiki(query: "Plan|p", notes: notes)
        #expect(items.map(\.kind) == [.note(title: "Work/Plan", alias: "p")])
    }

    @Test func a_name_match_shows_the_name_over_its_note_and_links_with_the_name() {
        let items = EditorSuggestions.wiki(query: "AI", notes: named)
        #expect(items.map(\.title) == ["AI", "Reading list"])
        #expect(items.map(\.subtitle) == ["\u{2192} Artificial Intelligence", nil])
        #expect(items.map(\.kind) == [
            .note(title: "Artificial Intelligence", alias: "AI"), .note(title: "Reading list", alias: ""),
        ])
    }

    @Test func an_exact_name_hides_the_create_row_and_a_partial_one_does_not() {
        #expect(!EditorSuggestions.wiki(query: "yapay zeka", notes: named).contains { $0.id.hasPrefix("create:") })
        #expect(EditorSuggestions.wiki(query: "yapay", notes: named).map(\.id).last == "create:yapay")
    }

    @Test func a_name_two_notes_share_is_two_rows_with_their_folders() {
        let shared = [Self.note("Machine Learning", in: "Tech", names: ["ML"]), Self.note("Markup Language", names: ["ML"])]
        let items = EditorSuggestions.wiki(query: "ml", notes: shared)
        #expect(items.map(\.subtitle) == ["\u{2192} Machine Learning \u{00B7} Tech", "\u{2192} Markup Language \u{00B7} /"])
        #expect(items.map(\.kind) == [
            .note(title: "Machine Learning", alias: "ML"), .note(title: "Markup Language", alias: "ML"),
        ])
    }

    @Test func a_path_link_to_a_real_note_is_not_broken() {
        let titles: Set<String> = ["plan", "ideas"]
        let paths = Set(notes.map(WikiTarget.pathKey(of:)))
        for target in ["Work/Plan", "work/plan.md", "/plan", "Work/Plan#Goals", "Ideas#Top"] {
            #expect(WikiTarget.names(target, titles: titles, paths: paths), "\(target) names a note")
        }
        for target in ["Home/Plan", "/Ideas", "Nope#Plan"] {
            #expect(!WikiTarget.names(target, titles: titles, paths: paths), "\(target) names nothing")
        }
    }

    @Test func the_heading_route_lands_on_the_first_matching_heading() {
        func block(_ kind: String, _ text: String) -> Block {
            Block(id: nil, kind: kind, depth: 0, props: [],
                  inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
        }
        let blocks = [block("paragraph", "Goals"), block("heading", "Intro"), block("heading", " goals "), block("heading", "Goals")]
        #expect(WikiTarget.headingIndex("  GOALS", in: blocks) == 2)
        #expect(WikiTarget.headingIndex("Missing", in: blocks) == nil)
    }

    @Test func a_saved_route_without_a_heading_still_decodes() throws {
        let route = try JSONDecoder().decode(NoteRoute.self, from: Data(#"{"id":"n1"}"#.utf8))
        #expect(route == NoteRoute(id: "n1"))
    }
}
