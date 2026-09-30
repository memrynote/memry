//
//  EditorInlineTests.swift
//  The `[[` and `@` triggers, their menus, and the text-to-core offsets the
//  keyboard toolbar writes with.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

@testable import Memry

@Suite("Editor inline triggers")
struct InlineTriggerTests {

    @Test func an_open_wiki_link_is_the_text_between_the_brackets() {
        // "see [[Du]]" with the caret after "Du".
        let trigger = InlineTrigger.active(in: "see [[Du]]", caret: 8)
        #expect(trigger == .wiki(range: NSRange(location: 4, length: 6), query: "Du"))
    }

    @Test func a_closed_wiki_link_is_not_a_trigger() {
        #expect(InlineTrigger.active(in: "[[Dune]] and", caret: 12) == nil)
    }

    @Test func a_mention_needs_a_space_or_the_start_before_the_at() {
        #expect(InlineTrigger.active(in: "@tom", caret: 4) == .mention(range: NSRange(location: 0, length: 4), query: "tom"))
        #expect(InlineTrigger.active(in: "hi @to", caret: 6) == .mention(range: NSRange(location: 3, length: 3), query: "to"))
        #expect(InlineTrigger.active(in: "a@b.c", caret: 5) == nil, "an address is not a mention")
    }

    @Test func a_typed_wiki_link_is_found_with_its_alias() {
        let matches = WikiLinkText.matches(in: "read [[Dune|the book]] and [[Emma]]")
        #expect(matches.map(\.target) == ["Dune", "Emma"])
        #expect(matches.map(\.alias) == ["the book", ""])
        #expect(matches[0].range == NSRange(location: 5, length: 17))
    }

    @Test func only_a_link_touching_the_typed_change_is_new() {
        #expect(WikiLinkText.typed(in: "a [[x]]", since: "a ").map(\.target) == ["x"])
        #expect(WikiLinkText.typed(in: "a [[x]] b", since: "a [[x]]").isEmpty, "typing after a link does not re-convert it")
        #expect(WikiLinkText.typed(in: "[[x]] and [[y]]", since: "[[x]] and [[y").map(\.target) == ["y"])
        #expect(WikiLinkText.typed(in: "[[x]]", since: "[[x]]").isEmpty)
        #expect(WikiLinkText.typed(in: "[[x]]", since: "[[x] ]]").map(\.target) == ["x"], "a deletion inside forms it")
    }

    @MainActor
    @Test func no_menu_trigger_opens_in_a_code_block() {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let code = Block(id: "c", kind: "codeBlock", depth: 0, props: [], inline: [])
        let field = BlockField(block: code, session: session, style: style, alignment: .natural)
        session.titles = ["Dune"]
        session.tags = ["work"]
        session.focusChanged(to: field)
        for text in ["[[Du", "@", "/", "#wo"] {
            field.textView.text = text
            field.textView.selectedRange = NSRange(location: (text as NSString).length, length: 0)
            session.selectionChanged(in: field)
            #expect(session.trigger == nil, "\(text) stays literal in code")
            #expect(session.tagTrigger == nil)
        }
    }
}

@Suite("Editor suggestion menus")
@MainActor
struct EditorSuggestionTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        return calendar
    }

    @Test func the_wiki_menu_offers_a_create_row_when_nothing_matches_exactly() {
        let items = EditorSuggestions.wiki(query: "Du", titles: ["Dune", "Emma", "Dubai"])
        #expect(items.map(\.kind) == [
            .note(title: "Dune", alias: ""), .note(title: "Dubai", alias: ""), .create(title: "Du", alias: ""),
        ])
        let exact = EditorSuggestions.wiki(query: "dune", titles: ["Dune"])
        #expect(!exact.contains { if case .create = $0.kind { true } else { false } })
    }

    @Test func the_mention_menu_leads_with_the_date_and_remind_rows() {
        let now = calendar.date(from: DateComponents(year: 2026, month: 9, day: 22, hour: 12)) ?? .now
        let items = EditorSuggestions.mention(query: "tomorrow", titles: ["Tomorrow plans"], now: now, calendar: calendar)
        #expect(items.map(\.id) == ["date", "remind", "note:Tomorrow plans"])
        guard case let .date(value) = items[0].kind, case let .date(remind) = items[1].kind else {
            Issue.record("expected two date rows")
            return
        }
        #expect(value.dateISO == "2026-09-23T09:00:00.000Z")
        #expect(value.hasTime == false && value.remind == "none")
        #expect(remind.remind == "at")
    }

    @Test func a_passed_reminder_moves_to_tomorrow_morning() {
        let now = calendar.date(from: DateComponents(year: 2026, month: 9, day: 22, hour: 12)) ?? .now
        let items = EditorSuggestions.mention(query: "", titles: [], now: now, calendar: calendar)
        guard case let .date(remind) = items.first(where: { $0.id == "remind" })?.kind else {
            Issue.record("expected a remind row")
            return
        }
        #expect(remind.dateISO == "2026-09-23T09:00:00.000Z")
    }

    @Test func a_query_that_is_not_a_date_lists_only_notes() {
        let items = EditorSuggestions.mention(query: "meeting", titles: ["Meeting notes"], now: .now)
        #expect(items.map(\.id) == ["note:Meeting notes"])
    }
}

@Suite("Editor text offsets")
@MainActor
struct BlockTextTests {
    private func run(_ text: String, _ marks: [String] = [], _ attrs: [String: String] = [:]) -> InlineRun {
        InlineRun(text: text, marks: marks, markAttrs: attrs, target: nil)
    }

    @Test func a_node_is_one_placeholder_and_zero_core_bytes() {
        let runs = [run("see "), run("", ["wikiLink"], ["wikiLink.target": "Dune"]), run(" later", ["bold"])]
        #expect(BlockText.shown(runs) == "see \u{FFFC} later")
        #expect(BlockText.isFormatted(runs))

        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let text = BlockText.attributed(runs, style: style)
        #expect(text.string == "see \u{FFFC} later")
        #expect(BlockText.coreOffset(in: text, utf16: 5) == 4, "the node takes no bytes")
        #expect(BlockText.coreOffset(in: text, utf16: 11) == 10)
    }

    @Test func offsets_are_utf8_bytes() {
        let text = NSAttributedString(string: "çay ☕️ x")
        #expect(BlockText.coreOffset(in: text, utf16: 4) == 5)
        #expect(BlockText.coreOffset(in: text, utf16: (text.string as NSString).length) == "çay ☕️ x".utf8.count)
    }
}

/// Records every edit it is asked to make.
private final class RecordingEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }

    var all: [BlockEdit] { edits.withLock { $0 } }
}

/// A block's typing is committed as the change from the text it started
/// from, so a peer's edit that merged underneath survives the commit.
@Suite("Editor commit from base")
@MainActor
struct EditorCommitBaseTests {
    private func paragraph(_ text: String) -> Block {
        Block(
            id: "a", kind: "paragraph", depth: 0, props: [],
            inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
        )
    }

    @Test func a_commit_over_a_moved_block_sends_replace_text_with_its_base() async {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("hello brave world", for: "a", current: "hello world!", base: "hello world")

        #expect(editor.all == [.replaceText(blockId: "a", text: "hello brave world", base: "hello world")])
    }

    @Test func typing_nothing_over_a_moved_block_writes_nothing() async {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)

        await model.commit("hello world", for: "a", current: "hello world!", base: "hello world")

        #expect(editor.all.isEmpty, "writing the stale text would delete the peer's edit")
    }

    @Test func a_dirty_field_commits_against_the_text_it_was_drawn_with() async {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        session.model = model
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: paragraph("hello world"), session: session, style: style, alignment: .natural)
        field.render()
        #expect(field.base == "hello world")

        // The user types; a peer's "!" merges and the block moves on under
        // the text view, which is not redrawn over unsaved typing.
        field.textView.text = "hello brave world"
        field.dirty = true
        field.block = paragraph("hello world!")

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.commit(field)
        }

        #expect(editor.all == [.replaceText(blockId: "a", text: "hello brave world", base: "hello world")])
        #expect(field.base == "hello brave world", "the next commit starts from what this one sent")
    }

    private func commit(_ session: EditorSession, _ field: BlockField) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.commit(field)
        }
    }

    /// The trace: commit #1 turns `[[x]]` into a link; the user types on
    /// before the page reloads; commit #2 must not convert `[[x]]` again at
    /// offsets that now cover the typed text.
    @Test func a_converted_link_is_not_converted_again_by_the_next_commit() async {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        session.model = model
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: paragraph("a "), session: session, style: style, alignment: .natural)
        field.render()

        field.textView.text = "a [[x]]"
        field.dirty = true
        await commit(session, field)

        let converted = editor.all.filter { if case .insertInline = $0 { true } else { false } }
        #expect(converted == [.insertInline(blockId: "a", start: 2, end: 7, kind: "wikiLink", text: "", attrs: ["target": "x", "alias": ""])])
        #expect(field.textView.text == "a \u{FFFC}", "the literal link is drawn as its chip at once")
        #expect(field.base == "a \u{FFFC}")

        // Typed before the reload: the block is still the stale "a ".
        field.textView.textStorage.append(NSAttributedString(string: " b"))
        field.dirty = true
        await commit(session, field)

        let after = editor.all.filter { if case .insertInline = $0 { true } else { false } }
        #expect(after.count == 1, "the second commit converts nothing")
        #expect(editor.all.last == .replaceText(blockId: "a", text: "a \u{FFFC} b", base: "a \u{FFFC}"))
    }

    @Test func a_code_block_keeps_a_typed_link_literal() async {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "note-1", editor: editor)
        let session = model.session
        session.model = model
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let code = Block(id: "a", kind: "codeBlock", depth: 0, props: [], inline: [])
        let field = BlockField(block: code, session: session, style: style, alignment: .natural)
        field.render()
        field.textView.text = "[[x]]"
        field.dirty = true
        await commit(session, field)
        #expect(!editor.all.contains { if case .insertInline = $0 { true } else { false } })
        #expect(field.textView.text == "[[x]]")
    }
}
