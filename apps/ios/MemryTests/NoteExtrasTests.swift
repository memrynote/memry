//
//  NoteExtrasTests.swift
//  N802 and N804 — the decisions export and reminders make.
//

import Foundation
import MemryCore
import Testing

@testable import Memry

@Suite("N802 export")
struct NoteExportTests {

    /// **Plain text, and the filename says so.**
    ///
    /// §12.1.2 gives a non-editor client `extract_text` and nothing else, so
    /// a file labelled `.md` whose contents are flattened text would be a
    /// quiet lie about what the user is getting.
    @Test func an_export_is_named_as_the_text_it_is() {
        let export = NoteExport(title: "Groceries", text: "buy cardamom")
        #expect(export.filename == "Groceries.txt")
    }

    /// A title is free text and can hold a slash, which is a path separator
    /// rather than a character in a filename.
    @Test func a_title_that_is_not_a_filename_is_made_into_one() {
        #expect(NoteExport(title: "2026/09/23", text: "x").filename == "2026-09-23.txt")
        #expect(NoteExport(title: "a: b", text: "x").filename == "a- b.txt")
        // An untitled note still gets a name rather than ".txt".
        #expect(NoteExport(title: "", text: "x").filename == "Untitled.txt")
        #expect(NoteExport(title: "   ", text: "x").filename == "Untitled.txt")
    }

    @Test func the_file_carries_the_title_then_the_body() {
        let export = NoteExport(title: "Groceries", text: "buy cardamom")
        #expect(export.contents == "Groceries\n\nbuy cardamom")
        // An untitled note is just its body, not a leading blank line.
        #expect(NoteExport(title: "", text: "body").contents == "body")
    }
}

@Suite("N804 a reminder is an instant")
struct NoteInstantTests {

    /// **UTC here, unlike a date mention.**
    ///
    /// A reminder fires at a moment and the moment is the same everywhere, so
    /// a fixed zone is right for this and wrong for a calendar day.
    @Test func an_instant_round_trips_through_utc() {
        let text = "2026-09-23T09:00:00.000Z"
        let date = NoteInstants.date(from: text)
        #expect(date != nil)
        #expect(NoteInstants.string(from: date!) == text)
    }

    /// Something that is not an instant comes back as itself rather than as a
    /// wrong date: the screen would rather show the raw value than a lie.
    @Test func an_unparseable_instant_is_shown_as_itself() {
        #expect(NoteInstants.date(from: "not a date") == nil)
        #expect(NoteInstants.label(for: "not a date") == "not a date")
    }

    /// A real instant reads as a date and time rather than as ISO text.
    @Test func a_real_instant_reads_as_a_date_and_time() {
        let label = NoteInstants.label(for: "2026-09-23T09:00:00.000Z")
        #expect(label != "2026-09-23T09:00:00.000Z")
        #expect(!label.isEmpty)
    }
}
