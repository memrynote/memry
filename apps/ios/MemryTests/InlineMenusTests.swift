//
//  InlineMenusTests.swift
//  N601, N602, N603 — the decisions the three inline menus make.
//

import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

private final class ScriptedInlineEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

@Suite("N601 dates")
struct NoteDateTests {

    /// **The day the user picked, not the day that instant falls on in UTC.**
    ///
    /// A `DatePicker` hands back local midnight. Spelling that instant with a
    /// UTC formatter writes the *previous* day for anyone east of Greenwich —
    /// a user in Istanbul picking the 23rd would have recorded the 22nd. The
    /// first version of this did exactly that, and this test caught it.
    @Test func a_date_is_spelled_as_the_day_the_user_picked() {
        var eastern = Calendar(identifier: .gregorian)
        eastern.timeZone = TimeZone(secondsFromGMT: 3 * 3600)!
        let localMidnight = eastern.date(
            from: DateComponents(year: 2026, month: 9, day: 23)
        )!

        #expect(NoteDates.string(from: localMidnight, calendar: eastern) == "2026-09-23")

        // And a calendar west of Greenwich spells its own day, for the same
        // reason: the note records the day, not the instant.
        var western = Calendar(identifier: .gregorian)
        western.timeZone = TimeZone(secondsFromGMT: -8 * 3600)!
        let westernMidnight = western.date(
            from: DateComponents(year: 2026, month: 9, day: 23)
        )!
        #expect(NoteDates.string(from: westernMidnight, calendar: western) == "2026-09-23")
    }

    /// The suggestions are computed from a given day rather than the wall
    /// clock, which is what makes them assertable at all.
    @Test func the_suggestions_are_relative_to_the_day_they_are_given() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let today = calendar.date(from: DateComponents(year: 2026, month: 9, day: 22))!

        let suggestions = NoteDates.suggestions(from: today, calendar: calendar)
        let labels = suggestions.map(\.0)
        #expect(labels == ["Today", "Tomorrow", "Next week", "Next month"])

        let iso = suggestions.map { NoteDates.string(from: $0.1, calendar: calendar) }
        #expect(iso[0] == "2026-09-22")
        #expect(iso[1] == "2026-09-23")
        #expect(iso[2] == "2026-09-29")
        #expect(iso[3] == "2026-10-22")
    }
}

@Suite("N601 a date mention reaches the core")
@MainActor
struct DateMentionWriteTests {

    @Test func a_date_mention_carries_its_date_and_reminder() async {
        let editor = ScriptedInlineEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let date = Calendar.current.date(
            from: DateComponents(year: 2026, month: 9, day: 23)
        )!

        await model.insertDateMention(
            in: "block-1", from: 4, to: 4, date: date, label: "Tomorrow", remindMe: true
        )

        guard case let .insertInline(blockId, start, end, kind, text, attrs) = editor.all.first
        else {
            Issue.record("expected an insertInline, got \(editor.all)")
            return
        }
        #expect(blockId == "block-1")
        #expect(start == 4 && end == 4)
        #expect(kind == "dateMention")
        #expect(text == "Tomorrow")
        #expect(attrs["date"] == "2026-09-23")
        #expect(attrs["remindMe"] == "true")
    }

    /// No reminder means the key is simply absent, rather than `"false"`.
    @Test func no_reminder_writes_no_reminder_key() async {
        let editor = ScriptedInlineEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.insertDateMention(
            in: "b", from: 0, to: 0, date: Date(), label: "Today", remindMe: false
        )

        guard case let .insertInline(_, _, _, _, _, attrs) = editor.all.first else {
            Issue.record("expected an insertInline")
            return
        }
        #expect(attrs["remindMe"] == nil)
    }
}

@Suite("N602 wiki links")
@MainActor
struct WikiLinkWriteTests {

    @Test func a_wiki_link_carries_its_target() async {
        let editor = ScriptedInlineEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.insertWikiLink(in: "b", from: 2, to: 2, title: "Cardamom")

        guard case let .insertInline(_, _, _, kind, text, attrs) = editor.all.first else {
            Issue.record("expected an insertInline")
            return
        }
        #expect(kind == "wikiLink")
        #expect(text == "Cardamom")
        #expect(attrs["target"] == "Cardamom")
        // No alias and no embed means neither key is written.
        #expect(attrs["displayAs"] == nil)
        #expect(attrs["embed"] == nil)
    }

    /// **An alias equal to the title is not an alias.**
    ///
    /// Writing one would make "no alias" and "an alias that happens to match"
    /// indistinguishable to every reader.
    @Test func an_alias_matching_the_title_is_not_written() async {
        let editor = ScriptedInlineEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.insertWikiLink(
            in: "b", from: 0, to: 0, title: "Cardamom", displayAs: "Cardamom"
        )

        guard case let .insertInline(_, _, _, _, _, attrs) = editor.all.first else {
            Issue.record("expected an insertInline")
            return
        }
        #expect(attrs["displayAs"] == nil)
    }

    @Test func an_alias_changes_what_the_link_shows() async {
        let editor = ScriptedInlineEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.insertWikiLink(
            in: "b", from: 0, to: 0, title: "Cardamom", displayAs: "the spice", embed: true
        )

        guard case let .insertInline(_, _, _, _, text, attrs) = editor.all.first else {
            Issue.record("expected an insertInline")
            return
        }
        #expect(text == "the spice", "the link shows the alias")
        #expect(attrs["target"] == "Cardamom", "and still points at the note")
        #expect(attrs["displayAs"] == "the spice")
        #expect(attrs["embed"] == "true")
    }
}

@Suite("N603 what a pasted link becomes")
struct PastedLinkTests {

    /// **A video option only where the address is a video.** An option that
    /// produces an empty player is worse than not offering it.
    @Test func a_video_option_appears_only_for_a_video() {
        #expect(PastedLink.choices(for: "https://example.com").contains(.video) == false)
        #expect(
            PastedLink.choices(for: "https://www.youtube.com/watch?v=abc123")
                .contains(.video)
        )
        #expect(PastedLink.choices(for: "https://youtu.be/abc123").contains(.video))
    }

    /// Both spellings YouTube uses, because a user pastes whichever one the
    /// share sheet gave them.
    @Test func both_youtube_spellings_yield_the_same_id() {
        #expect(PastedLink.videoId(of: "https://www.youtube.com/watch?v=abc123") == "abc123")
        #expect(PastedLink.videoId(of: "https://youtu.be/abc123") == "abc123")
        #expect(PastedLink.videoId(of: "https://example.com/watch?v=abc123") == nil)
        #expect(PastedLink.videoId(of: "not a url at all") == nil)
    }

    /// Every address gets the three that always work, so a paste is never a
    /// menu with nothing in it.
    @Test func every_address_offers_link_bookmark_and_mention() {
        for address in ["https://example.com", "https://youtu.be/x", "mailto:a@b.c"] {
            let choices = PastedLink.choices(for: address)
            #expect(choices.contains(.url), "\(address)")
            #expect(choices.contains(.bookmark), "\(address)")
            #expect(choices.contains(.mention), "\(address)")
        }
    }

    /// Every choice is a word, because a menu of glyphs reads as nothing to
    /// VoiceOver.
    @Test func every_choice_names_itself() {
        for choice in [PastedLink.url, .mention, .video, .bookmark] {
            #expect(!choice.name.isEmpty)
            #expect(!choice.symbol.isEmpty)
        }
    }
}
