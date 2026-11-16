//
//  SameNotePanesTests.swift
//  #4377: two panes on one note write through the vault's one editor to the
//  note's one document. Each pane draws the block it last read, so a pane can
//  hold typing on a block another pane has changed since. Its commit must keep
//  both panes' typing.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

@testable import Memry

@Suite("Two panes on one note", .serialized)
@MainActor
struct SameNotePanesTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let blockId: String
        let reader: CoreNotesReader
        let editor: CoreBlockEditor
    }

    private func fixture(_ text: String) throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Panes", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId,
            edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: text, newBlockId: blockId)
        )
        return Fixture(
            vault: vault, noteId: noteId, blockId: blockId,
            reader: CoreNotesReader(vault: vault.vault, executor: .shared),
            editor: CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        )
    }

    /// One pane's page: its model and session, as `NotePageContent` builds them.
    private func pane(_ f: Fixture, editor: (any BlockEditing)? = nil) -> NoteEditorViewModel {
        let model = NoteEditorViewModel(noteId: f.noteId, editor: editor ?? f.editor)
        model.session.model = model
        return model
    }

    private func block(_ f: Fixture) async throws -> Block {
        let blocks = try #require(try await f.reader.blocks(id: f.noteId))
        return try #require(blocks.first { $0.id == f.blockId })
    }

    private func stored(_ f: Fixture) async throws -> String {
        try await block(f).inline.map(\.text).joined()
    }

    /// The block's text view in `model`'s pane, drawn from `block`.
    private func draw(_ block: Block, in model: NoteEditorViewModel) -> BlockField {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
        field.render()
        return field
    }

    /// What a keystroke leaves: the new text, unsaved.
    private func type(_ text: String, in field: BlockField) {
        field.textView.text = text
        field.dirty = true
    }

    private func commit(_ field: BlockField, in model: NoteEditorViewModel) async {
        model.session.commit(field)
        await model.session.tail?.value
    }

    /// Pane B starts typing, pane A's edit lands, and B commits before it has
    /// re-read the note: B's block still shows the text both started from.
    @Test(.timeLimit(.minutes(1))) func a_pane_committing_before_it_rereads_keeps_the_other_panes_edit() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "A hello B")
        #expect(a.status == .idle)
        #expect(b.status == .idle)
    }

    /// B's page re-reads while it holds typing: the block moves on under the
    /// text view, which keeps what B typed (not redrawn over, #4519), and the
    /// commit lands only B's change on the live block.
    @Test(.timeLimit(.minutes(1))) func a_pane_rereading_under_its_typing_keeps_both_panes_edits() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        // What `updateUIView` does with the re-read block: a dirty field
        // takes the block and is not rendered.
        fieldB.block = try await block(f)
        #expect(fieldB.textView.text == "hello B")
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "A hello B")
    }

    /// Both panes keep typing across several commits each, interleaved.
    @Test(.timeLimit(.minutes(1))) func interleaved_commits_from_both_panes_keep_every_keystroke() async throws {
        let f = try fixture("mid")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("1 mid", in: fieldA)
        await commit(fieldA, in: a)
        type("mid 2", in: fieldB)
        await commit(fieldB, in: b)
        type("0 1 mid", in: fieldA)
        await commit(fieldA, in: a)
        type("mid 2 3", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "0 1 mid 2 3")
    }

    /// DATA-LOSS (REVIEW-4700): ⌘Z in B takes back only B's typing, and redo
    /// puts back only B's: A's typing in the same block, which landed after
    /// B's commit, stays through both.
    @Test(.timeLimit(.minutes(1))) func undo_and_redo_in_one_pane_keep_the_other_panes_typing() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello B", in: fieldB)
        await commit(fieldB, in: b)
        type("A hello", in: fieldA)
        await commit(fieldA, in: a)
        #expect(try await stored(f) == "A hello B")

        b.session.undo()
        await b.session.tail?.value
        #expect(try await stored(f) == "A hello", "B's undo kept A's typing")
        b.session.redo()
        await b.session.tail?.value
        #expect(try await stored(f) == "A hello B", "B's redo kept A's typing")
    }

    /// A `[[target]]` B typed becomes a link where the block holds it after
    /// B's rebased commit, not at the offsets of B's stale text.
    @Test(.timeLimit(.minutes(1))) func a_link_typed_in_a_stale_pane_converts_where_the_block_holds_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC}")
        #expect(runs.last?.markAttrs["wikiLink.target"] == "Foo")
    }

    /// B's undo of a link it typed takes back the link and B's typing, and
    /// keeps A's: the step's text after is B's own, with the node in, not the
    /// block as the core holds it.
    @Test(.timeLimit(.minutes(1))) func undo_of_a_link_typed_in_a_stale_pane_keeps_the_other_panes_typing() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello \u{FFFC}")

        b.session.undo()
        await b.session.tail?.value
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello")
    }

    /// DATA-LOSS (REVIEW-4700): B's redo of a link it typed puts the node
    /// over the literal where the block holds it once the typing is back,
    /// not at the offsets B recorded: A has typed before it since.
    @Test(.timeLimit(.minutes(1))) func redo_of_a_typed_link_after_the_other_pane_typed_before_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("hello [[Foo]]", in: fieldB)
        await commit(fieldB, in: b)
        #expect(BlockText.shown(try await block(f).inline) == "hello \u{FFFC}")
        b.session.undo()
        await b.session.tail?.value
        #expect(try await stored(f) == "hello")
        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)

        b.session.redo()
        await b.session.tail?.value
        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC}", "A's typing intact, no partial literal")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    /// DATA-LOSS (REVIEW-4700): a tag B picks goes over its `#query` where
    /// the block holds it after B's rebased commit, not at B's stale offsets.
    @Test(.timeLimit(.minutes(1))) func a_tag_picked_in_a_stale_pane_goes_where_the_block_holds_it() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        type("XYZ hello", in: fieldA)
        await commit(fieldA, in: a)
        b.session.tags = ["task"]
        b.session.focusChanged(to: fieldB)
        type("hello #ta", in: fieldB)
        fieldB.textView.selectedRange = NSRange(location: 9, length: 0)
        b.session.selectionChanged(in: fieldB)
        b.session.chooseTag(try #require(b.session.tagSuggestions.first { $0.tag == "task" }))
        await b.session.tail?.value

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC} ", "A's typing intact, no partial word")
        #expect(runs.filter { $0.marks.contains("hashTag") }.count == 1)
    }

    /// `field`'s text view in a key window, holding the caret at `selection`,
    /// as a tap in pane B leaves it.
    private func focus(_ field: BlockField, at selection: NSRange) throws -> UIWindow {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 400, height: 200)
        window.rootViewController = UIViewController()
        field.textView.delegate = field
        field.textView.frame = CGRect(x: 0, y: 40, width: 400, height: 60)
        window.rootViewController?.view.addSubview(field.textView)
        window.makeKeyAndVisible()
        #expect(field.textView.becomeFirstResponder())
        field.textView.selectedRange = selection
        return window
    }

    /// Keys as the keyboard delivers them: through the delegate, then
    /// `insertText` over the text view's selection.
    private func keys(_ text: String, in field: BlockField) {
        for character in text {
            let view = field.textView
            if view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: String(character)) != false {
                view.insertText(String(character))
            }
        }
    }

    /// DATA-LOSS (VERIFY-4700): A types `XYZ ` at the block's start, B's page
    /// re-reads under B's caret and redraws, then B types. The caret moves
    /// with B's text, so B's keys land where B put the caret.
    @Test(.timeLimit(.minutes(1))) func a_redraw_under_the_caret_keeps_the_caret_on_its_text() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 14, length: 0))
        defer { window.isHidden = true }

        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.selectedRange == NSRange(location: 18, length: 0))
        keys(" zz", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "XYZ golf body text zz")
    }

    /// DATA-LOSS (VERIFY-4700): B's tap selected `text` before A's edit
    /// landed. The selection stays on `text`, so B's keys replace only it:
    /// no byte B did not select is lost.
    @Test(.timeLimit(.minutes(1))) func a_redraw_under_a_selection_keeps_the_selection_on_its_text() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 10, length: 4))
        defer { window.isHidden = true }

        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.selectedRange == NSRange(location: 14, length: 4))
        keys(" zz", in: fieldB)
        await commit(fieldB, in: b)

        #expect(try await stored(f) == "XYZ golf body  zz")
    }

    /// An IME composition in B is not drawn over when A's edit lands: the
    /// redraw waits, then draws A's edit and the composed text.
    @Test(.timeLimit(.minutes(1))) func a_redraw_waits_for_a_composition_to_end() async throws {
        let f = try fixture("golf body text")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        let window = try focus(fieldB, at: NSRange(location: 14, length: 0))
        defer { window.isHidden = true }

        fieldB.textView.setMarkedText("zz", selectedRange: NSRange(location: 2, length: 0))
        // A commit mid-composition (the scene leaving the foreground).
        await commit(fieldB, in: b)
        type("XYZ golf body text", in: fieldA)
        await commit(fieldA, in: a)
        fieldB.block = try await block(f)
        fieldB.render()
        #expect(fieldB.textView.markedTextRange != nil, "the composition is kept")
        #expect(fieldB.textView.text == "golf body textzz")
        #expect(fieldB.stale)

        fieldB.textView.unmarkText()
        fieldB.render()
        #expect(!fieldB.stale)
        #expect(fieldB.textView.text == "XYZ golf body textzz")
        #expect(fieldB.textView.selectedRange == NSRange(location: 20, length: 0))
        #expect(try await stored(f) == "XYZ golf body textzz")
    }

    /// A pane's write is announced under its own source, so the other pane on
    /// the note re-reads (`NotePageLoad`) and the writer does not.
    @Test(.timeLimit(.minutes(1))) func a_landed_edit_is_announced_with_its_panes_source() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let fieldA = draw(try await block(f), in: a)
        // Other suites write in parallel: only this note's announcements.
        var heard: [UUID?] = []
        let token = NotificationCenter.default.addObserver(
            forName: AnnouncedEdits.bodyChanged, object: nil, queue: nil
        ) { [noteId = f.noteId] note in
            guard note.object as? String == noteId else { return }
            let source = note.userInfo?[AnnouncedEdits.sourceKey] as? UUID
            MainActor.assumeIsolated { heard.append(source) }
        }
        defer { NotificationCenter.default.removeObserver(token) }

        type("hello there", in: fieldA)
        await commit(fieldA, in: a)

        #expect(heard == [a.source])
    }

    // MARK: Nodes a stale pane puts in (#4706)

    private static let due = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
    /// With a reminder, which a lost chip would take with it.
    private static let moved = {
        var value = DateMentionValue(dateISO: "2026-07-14T09:00:00.000Z", hasTime: false)
        value.remind = "at"
        return value
    }()

    /// `hello ` and a date chip, anchored `dm_due`.
    private func fixtureWithDate() async throws -> Fixture {
        let f = try fixture("hello ")
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId,
            edit: .insertInline(
                blockId: f.blockId, start: 6, end: 6, kind: "dateMention", text: "", attrs: Self.due.attrs(anchorId: "dm_due")
            )
        )
        return f
    }

    /// A's `XYZ ` at the block's start, committed.
    private func prepend(in field: BlockField, of model: NoteEditorViewModel) async {
        field.textView.textStorage.insert(NSAttributedString(string: "XYZ "), at: 0)
        field.dirty = true
        await commit(field, in: model)
    }

    /// The date chip `field` draws, edited to `Self.moved` through the sheet.
    private func editDate(in field: BlockField, of model: NoteEditorViewModel) async throws {
        let range = try #require(field.dateChipRange(anchorId: "dm_due"))
        let chip = try #require(field.textView.textStorage.attribute(.memryDate, at: range.location, effectiveRange: nil) as? DateMentionChip)
        model.session.requestDateEdit(chip, in: field)
        model.session.applyDateEdit(.update(Self.moved))
        await model.session.tail?.value
    }

    private func dates(_ f: Fixture) async throws -> [[String: String]] {
        try await block(f).inline.filter { $0.marks.contains("dateMention") }.map(\.markAttrs)
    }

    /// One date chip, `dm_due`, holding the edited date and its reminder.
    private func expectMovedDate(_ f: Fixture) async throws {
        let dates = try await dates(f)
        #expect(dates.map { $0["dateMention.dateISO"] } == [Self.moved.dateISO])
        #expect(dates.map { $0["dateMention.remind"] } == ["at"])
        #expect(dates.map { $0["dateMention.anchorId"] } == ["dm_due"])
    }

    /// DATA-LOSS (#4706): B edits a date chip without having re-read A's
    /// `XYZ `. The chip is updated where the block holds it, and no byte of
    /// A's or the block's text goes.
    @Test(.timeLimit(.minutes(1))) func a_date_edited_in_a_stale_pane_keeps_every_byte() async throws {
        let f = try await fixtureWithDate()
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        await prepend(in: fieldA, of: a)
        try await editDate(in: fieldB, of: b)

        let shown = BlockText.shown(try await block(f).inline)
        #expect(shown == "XYZ hello \u{FFFC}")
        try await expectMovedDate(f)
        #expect(b.status == .idle)
    }

    /// #4762: B edits the chip after A's `XYZ ` it has not re-read, then
    /// undoes and redoes it. Each finds the chip by its anchor where the
    /// block holds it, keeps A's bytes, draws in B, and leaves A's text
    /// view alone.
    @Test(.timeLimit(.minutes(1))) func a_stale_panes_date_edit_is_undone_and_redone_where_the_chip_is() async throws {
        let f = try await fixtureWithDate()
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        b.session.reload = { [f] in
            let generation = b.session.landedWrites
            if let block = try? await block(f) { fieldB.receive(block, generation: generation) }
        }

        await prepend(in: fieldA, of: a)
        let paneA = fieldA.textView.text
        try await editDate(in: fieldB, of: b)
        try await expectMovedDate(f)
        #expect(fieldB.textView.text == "XYZ hello \u{FFFC}")
        let chipB = try #require(fieldB.dateChipRange(anchorId: "dm_due"))
        #expect((fieldB.textView.textStorage.attribute(.memryDate, at: chipB.location, effectiveRange: nil) as? DateMentionChip)?.value == Self.moved)

        b.session.undo()
        await b.session.tail?.value
        let dates = try await dates(f)
        #expect(dates.map { $0["dateMention.dateISO"] } == [Self.due.dateISO])
        #expect(dates.map { $0["dateMention.anchorId"] } == ["dm_due"])
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello \u{FFFC}")

        b.session.redo()
        await b.session.tail?.value
        try await expectMovedDate(f)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello \u{FFFC}")
        #expect(fieldA.textView.text == paneA)
        #expect(b.status == .idle)
    }

    /// #4706: a `[[` row B picks at the block's end lands at the end of the
    /// block as the core holds it, after A's `XYZ `.
    @Test(.timeLimit(.minutes(1))) func a_link_picked_in_a_stale_pane_lands_where_its_caret_is() async throws {
        let f = try fixture("hello ")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        await prepend(in: fieldA, of: a)
        type("hello [[Fo", in: fieldB)
        b.session.insertInline([.note(title: "Foo", alias: "")], replacing: NSRange(location: 6, length: 4), in: fieldB)
        await b.session.tail?.value

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC} ")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    /// #4765: B, which has not re-read A's `XYZ `, picks a date with its
    /// caret right after a link. The date lands after the link, where the
    /// block holds it, and B's undo takes back only the date and keeps A's
    /// typing.
    @Test(.timeLimit(.minutes(1))) func a_date_picked_after_a_link_in_a_stale_pane_lands_after_it() async throws {
        let f = try fixture("q  z")
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId,
            edit: .insertInline(
                blockId: f.blockId, start: 2, end: 2, kind: "wikiLink", text: "", attrs: WikiLinkAttrs.attrs(target: "Foo", alias: nil)
            )
        )
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)
        #expect(fieldB.textView.text == "q \u{FFFC} z")

        await prepend(in: fieldA, of: a)
        fieldB.textView.textStorage.insert(NSAttributedString(string: "@"), at: 3)
        fieldB.dirty = true
        b.session.insertInline([.date(Self.due)], replacing: NSRange(location: 3, length: 1), in: fieldB)
        await b.session.tail?.value

        let kinds = { [f] in try await self.block(f).inline.compactMap { $0.marks.first { BlockText.nodeKinds.contains($0) } } }
        #expect(BlockText.shown(try await block(f).inline) == "XYZ q \u{FFFC}\u{FFFC} z")
        #expect(try await kinds() == ["wikiLink", "dateMention"])

        b.session.undo()
        await b.session.tail?.value
        #expect(BlockText.shown(try await block(f).inline) == "XYZ q \u{FFFC} z")
        #expect(try await kinds() == ["wikiLink"])
    }

    /// #4706: the page menu's append from B, which has not re-read A's
    /// `XYZ `, lands at the end of the block as the core holds it.
    @Test(.timeLimit(.minutes(1))) func an_append_from_a_stale_pane_lands_at_the_live_end() async throws {
        let f = try fixture("hello")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)

        await prepend(in: fieldA, of: a)
        b.session.append(.note(title: "Foo", alias: ""), to: drawn)
        await b.session.tail?.value

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello\u{FFFC} ")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    /// `q `, a link to Foo, then ` z`.
    private func fixtureWithLink() throws -> Fixture {
        let f = try fixture("q  z")
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId,
            edit: .insertInline(
                blockId: f.blockId, start: 2, end: 2, kind: "wikiLink", text: "", attrs: WikiLinkAttrs.attrs(target: "Foo", alias: nil)
            )
        )
        return f
    }

    /// The inline nodes the block holds, in order, by kind.
    private func kinds(_ f: Fixture) async throws -> [String] {
        try await block(f).inline.compactMap { $0.marks.first { BlockText.nodeKinds.contains($0) } }
    }

    /// B, which has not re-read A's `XYZ `, types `@` right after the link
    /// and picks a date.
    private func pickDateAfterLink(in fieldB: BlockField, of b: NoteEditorViewModel) async {
        fieldB.textView.textStorage.insert(NSAttributedString(string: "@"), at: 3)
        fieldB.dirty = true
        b.session.insertInline([.date(Self.due)], replacing: NSRange(location: 3, length: 1), in: fieldB)
        await b.session.tail?.value
    }

    private func undo(in model: NoteEditorViewModel) async {
        model.session.undo()
        await model.session.tail?.value
    }

    private func redo(in model: NoteEditorViewModel) async {
        model.session.redo()
        await model.session.tail?.value
    }

    /// DATA-LOSS (#4794): B's redo of a date it picked puts the date back
    /// where the block holds its place, after the link, not at B's stale
    /// offsets inside A's `XYZ `.
    @Test(.timeLimit(.minutes(1))) func redo_of_a_date_picked_in_a_stale_pane_lands_where_the_block_holds_it() async throws {
        let f = try fixtureWithLink()
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        await prepend(in: fieldA, of: a)
        await pickDateAfterLink(in: fieldB, of: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ q \u{FFFC}\u{FFFC} z")
        await undo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ q \u{FFFC} z")

        await redo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ q \u{FFFC}\u{FFFC} z", "A's XYZ intact")
        #expect(try await stored(f) == "XYZ q  z")
        #expect(try await kinds(f) == ["wikiLink", "dateMention"])
        #expect(b.status == .idle)
    }

    /// #4794: A keeps typing on both sides after B's pick. B's undo takes
    /// back only the date and B's redo puts it back after the link, and
    /// every byte A typed stays through both.
    @Test(.timeLimit(.minutes(1))) func undo_and_redo_of_a_stale_panes_date_keep_the_other_panes_later_typing() async throws {
        let f = try fixtureWithLink()
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        await prepend(in: fieldA, of: a)
        await pickDateAfterLink(in: fieldB, of: b)
        fieldA.textView.textStorage.insert(NSAttributedString(string: "W "), at: 0)
        fieldA.textView.textStorage.append(NSAttributedString(string: "!"))
        fieldA.dirty = true
        await commit(fieldA, in: a)
        #expect(BlockText.shown(try await block(f).inline) == "W XYZ q \u{FFFC}\u{FFFC} z!")

        await undo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "W XYZ q \u{FFFC} z!")
        #expect(try await kinds(f) == ["wikiLink"])

        await redo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "W XYZ q \u{FFFC}\u{FFFC} z!")
        #expect(try await kinds(f) == ["wikiLink", "dateMention"])
        #expect(b.status == .idle)
    }

    /// #4794: a `[[` row B picked after A's unseen `XYZ ` is redone where
    /// the block holds it.
    @Test(.timeLimit(.minutes(1))) func redo_of_a_link_picked_in_a_stale_pane_lands_where_the_block_holds_it() async throws {
        let f = try fixture("hello ")
        let a = pane(f)
        let b = pane(f)
        let drawn = try await block(f)
        let fieldA = draw(drawn, in: a)
        let fieldB = draw(drawn, in: b)

        await prepend(in: fieldA, of: a)
        type("hello [[Fo", in: fieldB)
        b.session.insertInline([.note(title: "Foo", alias: "")], replacing: NSRange(location: 6, length: 4), in: fieldB)
        await b.session.tail?.value
        await undo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "XYZ hello ")

        await redo(in: b)
        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC} ")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    /// DATA-LOSS (#4794): A rewrote the text around the place of B's undone
    /// date. B's redo finds no place for it, so it writes no node over A's
    /// text, at B's offsets or anywhere, and says so.
    @Test(.timeLimit(.minutes(1))) func redo_of_a_node_whose_place_is_gone_writes_nothing_and_says_so() async throws {
        let f = try fixtureWithLink()
        let a = pane(f)
        let b = pane(f)
        let fieldB = draw(try await block(f), in: b)

        await pickDateAfterLink(in: fieldB, of: b)
        await undo(in: b)
        let fieldA = draw(try await block(f), in: a)
        type("other words", in: fieldA)
        await commit(fieldA, in: a)
        #expect(BlockText.shown(try await block(f).inline) == "other words")

        await redo(in: b)
        #expect(BlockText.shown(try await block(f).inline) == "other words")
        #expect(try await kinds(f) == [])
        #expect(b.status == .failed(NodeAnchor.gone))
    }

    /// The core's editor, except that once armed, another pane's write
    /// (`XYZ ` at the block's start, unless told otherwise) lands just before
    /// the next inline node does: after the pane decided where it goes.
    private final class WritesFirst: BlockEditing, Sendable {
        let core: CoreBlockEditor
        let reader: CoreNotesReader
        let blockId: String
        let rewrite: @Sendable (String) -> String
        let armed = Mutex(false)
        init(_ f: Fixture, rewrite: @escaping @Sendable (String) -> String = { "XYZ " + $0 }) {
            core = f.editor
            reader = f.reader
            blockId = f.blockId
            self.rewrite = rewrite
        }

        private func interpose(_ noteId: String) async throws {
            guard armed.withLock({ armed in defer { armed = false }; return armed }) else { return }
            let blocks = try await reader.blocks(id: noteId)
            let live = blocks?.first { $0.id == blockId }?.inline.map(\.text).joined() ?? ""
            _ = try await core.edit(noteId: noteId, .replaceText(blockId: blockId, text: rewrite(live), base: live))
        }

        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            if case .insertInline = edit { try await interpose(noteId) }
            return try await core.edit(noteId: noteId, edit)
        }

        func edit(
            noteId: String, blockId: String, locating locate: @escaping @Sendable ([InlineRun]?) -> BlockEdit?
        ) async throws -> LocatedEdit {
            // A located text write, such as a date chip's swap for its
            // space, is not the node.
            let runs = try await reader.blocks(id: noteId)?.first { $0.id == blockId }?.inline
            if case .insertInline = locate(runs) { try await interpose(noteId) }
            return try await core.edit(noteId: noteId, blockId: blockId, locating: locate)
        }
    }

    /// DATA-LOSS (#4706): another pane's write lands after B's commit and
    /// before B's date chip goes back in. The chip goes where the block
    /// holds its space then, and no byte of the other write goes.
    @Test(.timeLimit(.minutes(1))) func a_write_between_a_date_edits_commit_and_its_chip_keeps_every_byte() async throws {
        let f = try await fixtureWithDate()
        let editor = WritesFirst(f)
        let b = pane(f, editor: editor)
        let fieldB = draw(try await block(f), in: b)

        editor.armed.withLock { $0 = true }
        try await editDate(in: fieldB, of: b)

        let shown = BlockText.shown(try await block(f).inline)
        #expect(shown == "XYZ hello \u{FFFC}")
        #expect(try await dates(f).map { $0["dateMention.anchorId"] } == ["dm_due"])
    }

    /// DATA-LOSS (REVIEW-4758): another pane's unseen edits sit on both
    /// sides of the chip's space. The space is found by the text next to it,
    /// and the chip goes back over it.
    @Test(.timeLimit(.minutes(1))) func a_date_chip_between_two_unseen_edits_goes_back_in_place() async throws {
        let f = try await fixtureWithDate()
        let editor = WritesFirst(f) { "XYZ " + $0 + "!" }
        let b = pane(f, editor: editor)
        let fieldB = draw(try await block(f), in: b)

        editor.armed.withLock { $0 = true }
        try await editDate(in: fieldB, of: b)

        let shown = BlockText.shown(try await block(f).inline)
        #expect(shown == "XYZ hello \u{FFFC}!")
        try await expectMovedDate(f)
        #expect(b.status == .idle)
    }

    /// DATA-LOSS (REVIEW-4758): another pane's write takes the space B's
    /// date edit wrote before the chip goes back in. The chip is not put in
    /// over the other pane's text, and not lost with its reminder: it goes
    /// at the end of the block's text, and the status says so.
    @Test(.timeLimit(.minutes(1))) func a_date_chip_whose_space_another_pane_took_goes_at_the_end_and_says_so() async throws {
        let f = try await fixtureWithDate()
        let editor = WritesFirst(f) { $0.dropLast() + "X" }
        let b = pane(f, editor: editor)
        let fieldB = draw(try await block(f), in: b)

        editor.armed.withLock { $0 = true }
        try await editDate(in: fieldB, of: b)

        let shown = BlockText.shown(try await block(f).inline)
        #expect(shown == "hello X\u{FFFC}")
        try await expectMovedDate(f)
        #expect(b.status == .failed(NodeAnchor.moved))
    }

    /// REVIEW-4758: a node for a block the note no longer holds is refused
    /// as any edit to it is, and says so.
    @Test(.timeLimit(.minutes(1))) func a_node_for_a_missing_block_reports_the_refusal() async throws {
        let f = try fixture("hello")
        let model = pane(f)
        let anchor = NodeAnchor(typed: "hello ", location: 5, replaces: false, paneRange: 5 ..< 5)

        #expect(await model.insertDateMention(in: "no-such-block", at: anchor, value: Self.due) == nil)

        #expect(model.status == .failed(ErrorMapping.unknownNote))
        #expect(try await stored(f) == "hello")
    }

    /// DATA-LOSS (REVIEW-4700 on #4706): another pane's write lands between
    /// B's commit of a typed `[[Foo]]` and its link node. The node goes over
    /// the literal where the block holds it then.
    @Test(.timeLimit(.minutes(1))) func a_write_between_a_typed_links_commit_and_its_node_keeps_every_byte() async throws {
        let f = try fixture("hello")
        let editor = WritesFirst(f)
        let b = pane(f, editor: editor)
        let fieldB = draw(try await block(f), in: b)

        type("hello [[Foo]]", in: fieldB)
        editor.armed.withLock { $0 = true }
        await commit(fieldB, in: b)

        let runs = try await block(f).inline
        #expect(BlockText.shown(runs) == "XYZ hello \u{FFFC}")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }
}

@Suite("A range carried across a redraw")
@MainActor
struct BlockTextCarryTests {
    @Test func a_caret_after_an_insert_moves_by_its_length() {
        #expect(BlockText.carry(NSRange(location: 4, length: 0), from: "golf", to: "XYZ golf") == NSRange(location: 8, length: 0))
    }

    @Test func a_caret_before_an_insert_stays() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "golf", to: "golf XYZ") == NSRange(location: 2, length: 0))
    }

    @Test func a_selection_after_a_deletion_moves_back() {
        #expect(BlockText.carry(NSRange(location: 8, length: 4), from: "XYZ golf body", to: "golf body") == NSRange(location: 4, length: 4))
    }

    @Test func a_caret_inside_a_replaced_span_goes_to_its_end() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "abcdef", to: "aXYZef") == NSRange(location: 4, length: 0))
    }

    @Test func a_selection_around_an_insert_grows_with_it() {
        #expect(BlockText.carry(NSRange(location: 0, length: 4), from: "golf", to: "goXlf") == NSRange(location: 0, length: 5))
    }

    @Test func offsets_count_utf16() {
        #expect(BlockText.carry(NSRange(location: 2, length: 0), from: "ab", to: "🙂ab") == NSRange(location: 4, length: 0))
    }

    @Test func unchanged_text_keeps_the_range() {
        #expect(BlockText.carry(NSRange(location: 1, length: 2), from: "abc", to: "abc") == NSRange(location: 1, length: 2))
    }
}
