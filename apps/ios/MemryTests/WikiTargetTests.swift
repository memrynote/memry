//
//  WikiTargetTests.swift
//  Path-form wiki links: the `[[` menu's path stems for shared titles, the
//  broken-link check, and the heading a link scrolls to.
//

import Foundation
import MemryCore
import Testing

@testable import Memry

@Suite("Wiki link targets")
@MainActor
struct WikiTargetTests {
    private let notes = [
        WikiLinkNote(title: "Plan", folderPath: "Work"),
        WikiLinkNote(title: "plan", folderPath: nil),
        WikiLinkNote(title: "Ideas", folderPath: "Work"),
    ]

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
