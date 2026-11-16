//
//  InlineNodeUndoTests.swift
//  REVIEW-4700: one pane, the real core. A commit that puts a link or date
//  node in records one undo step that takes back the typing and the node
//  together, and whose redo puts back exactly one node and no literal.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

@testable import Memry

@Suite("Undo over inserted inline nodes", .serialized)
@MainActor
struct InlineNodeUndoTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let blockId: String
        let reader: CoreNotesReader
        let model: NoteEditorViewModel
        let field: BlockField
        @MainActor var session: EditorSession { model.session }
    }

    /// A note holding one paragraph, `text`, open and focused in one pane,
    /// beside a note titled "Agent Dune" to link to.
    private func fixture(
        _ text: String, editor wrap: (CoreBlockEditor) -> any BlockEditing = { $0 }
    ) async throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Undo", folderPath: nil)
        _ = try writer.create(title: "Agent Dune", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId,
            edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: text, newBlockId: blockId)
        )
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: wrap(editor))
        model.session.model = model
        model.session.linkNotes = try await reader.list()
        let block = try #require(try await reader.blocks(id: noteId)?.first { $0.id == blockId })
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
        field.render()
        model.session.focusChanged(to: field)
        return Fixture(vault: vault, noteId: noteId, blockId: blockId, reader: reader, model: model, field: field)
    }

    private func runs(_ f: Fixture) async throws -> [InlineRun] {
        let blocks = try #require(try await f.reader.blocks(id: f.noteId))
        return try #require(blocks.first { $0.id == f.blockId }).inline
    }

    private func shown(_ f: Fixture) async throws -> String {
        BlockText.shown(try await runs(f))
    }

    private func nodes(_ f: Fixture, _ kind: String) async throws -> Int {
        try await runs(f).filter { $0.marks.contains(kind) }.count
    }

    /// Unsaved typing at the end of the block.
    private func type(_ text: String, in f: Fixture) {
        f.field.textView.textStorage.append(NSAttributedString(string: text))
        f.field.dirty = true
        f.field.textView.selectedRange = NSRange(location: f.field.textView.textStorage.length, length: 0)
    }

    private func undo(_ f: Fixture) async {
        f.session.undo()
        await f.session.tail?.value
    }

    private func redo(_ f: Fixture) async {
        f.session.redo()
        await f.session.tail?.value
    }

    @Test(.timeLimit(.minutes(1))) func a_link_chosen_from_the_menu_is_undone_with_its_space() async throws {
        let f = try await fixture("see ")
        type("[[Agent", in: f)
        f.session.selectionChanged(in: f.field)
        let row = try #require(f.session.suggestions.first { $0.kind == .note(title: "Agent Dune", alias: "") })
        f.session.choose(row)
        await f.session.tail?.value
        #expect(try await shown(f) == "see \u{FFFC} ")

        await undo(f)
        #expect(try await shown(f) == "see ", "no node and no stray space")
        #expect(try await nodes(f, "wikiLink") == 0)

        await redo(f)
        #expect(try await shown(f) == "see \u{FFFC} ")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Agent Dune"])
    }

    @Test(.timeLimit(.minutes(1))) func a_typed_link_is_undone_to_the_text_and_redone_as_one_node() async throws {
        let f = try await fixture("hello")
        type(" see [[Foo]]", in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "hello see \u{FFFC}")

        await undo(f)
        #expect(try await shown(f) == "hello")
        #expect(try await nodes(f, "wikiLink") == 0)

        await redo(f)
        #expect(try await shown(f) == "hello see \u{FFFC}", "one node, no literal")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])
    }

    @Test(.timeLimit(.minutes(1))) func a_tag_chosen_from_the_menu_is_undone_and_redone_as_one_node() async throws {
        let f = try await fixture("hello ")
        try pickTag("#ta", in: f)
        await f.session.tail?.value
        #expect(try await shown(f) == "hello \u{FFFC} ")

        await undo(f)
        #expect(try await shown(f) == "hello ")
        #expect(try await nodes(f, "hashTag") == 0)

        await redo(f)
        #expect(try await shown(f) == "hello \u{FFFC} ", "one node, no literal")
        #expect(try await nodes(f, "hashTag") == 1)
    }

    @Test(.timeLimit(.minutes(1))) func a_date_chosen_from_the_menu_is_undone_with_its_space() async throws {
        let f = try await fixture("due ")
        type("@tom", in: f)
        let value = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
        f.session.insertInline(.date(value), replacing: NSRange(location: 4, length: 4))
        await f.session.tail?.value
        #expect(try await shown(f) == "due \u{FFFC} ")

        await undo(f)
        #expect(try await shown(f) == "due ")
        #expect(try await nodes(f, "dateMention") == 0)

        await redo(f)
        #expect(try await shown(f) == "due \u{FFFC} ")
        #expect(try await nodes(f, "dateMention") == 1)
    }

    @Test(.timeLimit(.minutes(1))) func a_dropped_note_is_undone_with_its_space() async throws {
        let f = try await fixture("see ")
        let note = try #require(try await f.reader.list().first { $0.title == "Agent Dune" })
        await f.session.dropNotes([NoteDrag.provider(for: note, vaultId: "vault-test") { nil }], at: 4, in: f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "see \u{FFFC} ")

        await undo(f)
        #expect(try await shown(f) == "see ")
        #expect(try await nodes(f, "wikiLink") == 0)
    }

    /// The core's editor, except that reading a block back fails.
    private struct UnreadableBlocks: BlockEditing {
        let core: CoreBlockEditor
        struct ReadFailed: Error {}
        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            try await core.edit(noteId: noteId, edit)
        }
        func edit(
            noteId: String, blockId: String, locating locate: @escaping @Sendable ([InlineRun]?) -> BlockEdit?
        ) async throws -> LocatedEdit { throw ReadFailed() }
    }

    /// The pane's offsets may miss a literal another pane moved, so a typed
    /// link whose block cannot be read stays text.
    @Test(.timeLimit(.minutes(1))) func a_typed_link_stays_text_when_its_block_cannot_be_read() async throws {
        let f = try await fixture("hello", editor: { UnreadableBlocks(core: $0) })
        type(" see [[Foo]]", in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "hello see [[Foo]]")
        #expect(try await nodes(f, "wikiLink") == 0)
    }

    /// The core's editor, except that it refuses the first inline node.
    private final class RefusesFirstNode: BlockEditing, Sendable {
        let core: CoreBlockEditor
        private let refused = Mutex(false)
        init(core: CoreBlockEditor) { self.core = core }
        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            if case .insertInline = edit, refused.withLock({ done in defer { done = true }; return !done }) {
                return false
            }
            return try await core.edit(noteId: noteId, edit)
        }
    }

    /// The core's editor, except that once armed it refuses typing, or the
    /// next inline node.
    private final class Refuses: BlockEditing, Sendable {
        enum Mode { case nothing, typing, nextNode }
        let core: CoreBlockEditor
        let mode = Mutex(Mode.nothing)
        init(core: CoreBlockEditor) { self.core = core }
        func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
            let refused = mode.withLock { mode in
                switch (mode, edit) {
                case (.typing, .replaceText): return true
                case (.nextNode, .insertInline): mode = .nothing; return true
                default: return false
                }
            }
            return refused ? false : try await core.edit(noteId: noteId, edit)
        }
    }

    private func pickTag(_ typed: String, in f: Fixture) throws {
        f.session.tags = ["task"]
        type(typed, in: f)
        f.session.selectionChanged(in: f.field)
        f.session.chooseTag(try #require(f.session.tagSuggestions.first { $0.tag == "task" }))
    }

    /// REVIEW-4700: a redo whose typing the core refused puts no node in. The
    /// literal it would find is another writer's text, and the refusal shows.
    @Test(.timeLimit(.minutes(1))) func a_refused_redo_puts_no_node_over_another_writers_text() async throws {
        var refuses: Refuses?
        let f = try await fixture("hello ", editor: { core in
            let editor = Refuses(core: core)
            refuses = editor
            return editor
        })
        try pickTag("#ta", in: f)
        await f.session.tail?.value
        await undo(f)
        let core = try #require(refuses).core
        _ = try await core.edit(noteId: f.noteId, .replaceText(blockId: f.blockId, text: "hello #ta ", base: "hello "))
        try #require(refuses).mode.withLock { $0 = .typing }

        await redo(f)
        #expect(try await shown(f) == "hello #ta ", "the other writer's text stays")
        #expect(try await nodes(f, "hashTag") == 0)
        guard case .failed = f.model.status else { Issue.record("status is \(f.model.status)"); return }
    }

    /// A node a redo could not put back stays the status after one that
    /// went in.
    @Test(.timeLimit(.minutes(1))) func a_refused_node_in_a_redo_stays_the_status() async throws {
        var refuses: Refuses?
        let f = try await fixture("hello", editor: { core in
            let editor = Refuses(core: core)
            refuses = editor
            return editor
        })
        try pickTag(" [[Foo]] #ta", in: f)
        await f.session.tail?.value
        #expect(try await shown(f) == "hello \u{FFFC} \u{FFFC} ")
        await undo(f)
        try #require(refuses).mode.withLock { $0 = .nextNode }

        await redo(f)
        #expect(try await nodes(f, "wikiLink") == 1)
        guard case .failed = f.model.status else { Issue.record("status is \(f.model.status)"); return }
    }

    /// Unsaved typing at UTF-16 `location`, with the caret after it.
    private func type(_ text: String, at location: Int, in f: Fixture) {
        f.field.textView.textStorage.insert(NSAttributedString(string: text), at: location)
        f.field.dirty = true
        f.field.textView.selectedRange = NSRange(location: location + (text as NSString).length, length: 0)
    }

    /// `qq `, then a committed link node to Foo, then `tail`.
    private func linked(_ tail: String) async throws -> Fixture {
        let f = try await fixture("qq ")
        type("[[Foo]]" + tail, in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC}" + tail)
        return f
    }

    private func kinds(_ f: Fixture) async throws -> [String] {
        try await runs(f).compactMap { run in run.marks.first { BlockText.nodeKinds.contains($0) } }
    }

    /// VERIFY-4700: a tag picked right before a link node keeps the link,
    /// and its undo and redo take back and put back only the tag.
    @Test(.timeLimit(.minutes(1))) func a_tag_picked_before_a_node_keeps_the_node() async throws {
        let f = try await linked(" ")
        f.session.tags = ["wo"]
        type("#wo", at: 3, in: f)
        f.session.selectionChanged(in: f.field)
        f.session.chooseTag(try #require(f.session.tagSuggestions.first { $0.tag == "wo" }))
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} ")
        #expect(try await kinds(f) == ["hashTag", "wikiLink"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC} ")
        #expect(try await kinds(f) == ["wikiLink"])

        await redo(f)
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} ")
        #expect(try await kinds(f) == ["hashTag", "wikiLink"])
    }

    /// VERIFY-4700, as the keyboard leaves it: the link went in when the
    /// caret left its `]]`, the space after it is not written yet, and the
    /// tag is typed before it. One write with typing on both sides of the
    /// link kept the link.
    @Test(.timeLimit(.minutes(1))) func a_tag_picked_before_a_node_with_typing_after_it_keeps_the_node() async throws {
        let f = try await linked("")
        type(" ", in: f)
        f.session.tags = ["wo"]
        type("#wo", at: 3, in: f)
        f.session.selectionChanged(in: f.field)
        f.session.chooseTag(try #require(f.session.tagSuggestions.first { $0.tag == "wo" }))
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} ")
        #expect(try await kinds(f) == ["hashTag", "wikiLink"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC}")
        #expect(try await kinds(f) == ["wikiLink"])

        await redo(f)
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} ")
        #expect(try await kinds(f) == ["hashTag", "wikiLink"])
    }

    /// Typing on both sides of a node in one write keeps the node, and its
    /// undo does too.
    @Test(.timeLimit(.minutes(1))) func typing_on_both_sides_of_a_node_keeps_it() async throws {
        let f = try await linked("")
        type(" after", in: f)
        type("before ", at: 0, in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "before qq \u{FFFC} after")
        #expect(try await kinds(f) == ["wikiLink"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC}")
        #expect(try await kinds(f) == ["wikiLink"])
    }

    /// VERIFY-4700 Low: a redo that puts a tag back before an equal node
    /// leaves the caret after the tag and its space, where the pick left it.
    @Test(.timeLimit(.minutes(1))) func a_redone_tag_leaves_the_caret_after_it() async throws {
        let f = try await linked(" ")
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true }
        window.rootViewController = UIViewController()
        f.field.textView.frame = CGRect(x: 0, y: 0, width: 400, height: 60)
        window.rootViewController?.view.addSubview(f.field.textView)
        window.makeKeyAndVisible()
        #expect(f.field.textView.becomeFirstResponder())
        f.session.tags = ["wo"]
        type("#wo", at: 3, in: f)
        f.session.selectionChanged(in: f.field)
        f.session.chooseTag(try #require(f.session.tagSuggestions.first { $0.tag == "wo" }))
        await f.session.tail?.value
        await undo(f)
        f.field.block = try #require(try await f.reader.blocks(id: f.noteId)?.first { $0.id == f.blockId })
        f.field.render()
        f.field.textView.selectedRange = NSRange(location: 3, length: 0)

        await redo(f)
        f.field.block = try #require(try await f.reader.blocks(id: f.noteId)?.first { $0.id == f.blockId })
        f.field.render()
        #expect(f.field.textView.text == "qq \u{FFFC} \u{FFFC} ")
        #expect(f.field.textView.selectedRange == NSRange(location: 5, length: 0))
    }

    /// A tag picked right after a node, and one between two nodes.
    @Test(.timeLimit(.minutes(1))) func a_tag_picked_between_nodes_keeps_both() async throws {
        let f = try await linked(" ")
        type("[[Bar]]", in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC}")
        f.session.tags = ["wo"]
        type("#wo", at: 5, in: f)
        f.session.selectionChanged(in: f.field)
        f.session.chooseTag(try #require(f.session.tagSuggestions.first { $0.tag == "wo" }))
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} \u{FFFC}")
        #expect(try await kinds(f) == ["wikiLink", "hashTag", "wikiLink"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC}")
        #expect(try await kinds(f) == ["wikiLink", "wikiLink"])

        await redo(f)
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC} \u{FFFC}")
        #expect(try await kinds(f) == ["wikiLink", "hashTag", "wikiLink"])
    }

    /// A link typed right before a node, and one chosen from the menu there.
    @Test(.timeLimit(.minutes(1))) func a_link_typed_before_a_node_keeps_the_node() async throws {
        let f = try await linked("")
        type("[[Bar]] ", at: 3, in: f)
        f.session.commit(f.field)
        await f.session.tail?.value
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC}")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Bar", "Foo"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC}")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])

        await redo(f)
        #expect(try await shown(f) == "qq \u{FFFC} \u{FFFC}")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Bar", "Foo"])
    }

    @Test(.timeLimit(.minutes(1))) func a_link_chosen_before_a_node_keeps_the_node() async throws {
        let f = try await linked("")
        type("[[Agent", at: 3, in: f)
        f.session.selectionChanged(in: f.field)
        let row = try #require(f.session.suggestions.first { $0.kind == .note(title: "Agent Dune", alias: "") })
        f.session.choose(row)
        await f.session.tail?.value
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Agent Dune", "Foo"])

        await undo(f)
        #expect(try await shown(f) == "qq \u{FFFC}")
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo"])

        await redo(f)
        #expect(try await runs(f).filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Agent Dune", "Foo"])
    }

    /// A node the core refused is not in the step: redo puts back the typing
    /// the user had, and no node they never saw.
    @Test(.timeLimit(.minutes(1))) func a_refused_node_is_not_redone() async throws {
        let f = try await fixture("due ", editor: { RefusesFirstNode(core: $0) })
        type("@tom", in: f)
        let value = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
        f.session.insertInline(.date(value), replacing: NSRange(location: 4, length: 4))
        await f.session.tail?.value
        #expect(try await shown(f) == "due  ")
        #expect(try await nodes(f, "dateMention") == 0)

        await undo(f)
        #expect(try await shown(f) == "due ")

        await redo(f)
        #expect(try await shown(f) == "due  ")
        #expect(try await nodes(f, "dateMention") == 0, "no node the user never had")
    }

    // MARK: A date chip edited through its sheet (#4762)

    /// The chip's first date, with a reminder undo must bring back.
    private static let due = {
        var value = DateMentionValue(dateISO: "2026-06-02T09:00:00.000Z", hasTime: false)
        value.remind = "1d"
        return value
    }()

    private static let moved = {
        var value = DateMentionValue(dateISO: "2026-07-14T09:00:00.000Z", hasTime: false)
        value.remind = "at"
        return value
    }()

    /// `hello ` and the date chip `dm_due`, drawn in the pane, which re-reads
    /// the block after every write as the page does (`updateUIView`).
    /// With `anchored` false, a chip written before anchors existed.
    private func fixtureWithDate(anchored: Bool = true) async throws -> Fixture {
        let f = try await fixture("hello ")
        var attrs = Self.due.attrs(anchorId: "dm_due")
        if !anchored { attrs["anchorId"] = nil }
        _ = try f.vault.vault.notesWriter(store: TaskTestKeychain()).editBlock(
            noteId: f.noteId,
            edit: .insertInline(blockId: f.blockId, start: 6, end: 6, kind: "dateMention", text: "", attrs: attrs)
        )
        let reread = { @MainActor [f] in
            let generation = f.session.landedWrites
            let blocks = try await f.reader.blocks(id: f.noteId)
            if let block = blocks?.first(where: { $0.id == f.blockId }) { f.field.receive(block, generation: generation) }
        }
        try await reread()
        f.session.reload = { try? await reread() }
        return f
    }

    /// The chip the pane's text view draws: its one U+FFFC's node.
    private func drawnChip(_ f: Fixture) throws -> DateMentionChip {
        let text = f.field.textView.attributedText ?? NSAttributedString()
        #expect(text.string == "hello \u{FFFC}")
        return try #require(text.attribute(.memryDate, at: 6, effectiveRange: nil) as? DateMentionChip)
    }

    /// The core's date nodes: date, reminder and anchor of each.
    private func dates(_ f: Fixture) async throws -> [[String?]] {
        try await runs(f).filter { $0.marks.contains("dateMention") }.map { run in
            ["dateMention.dateISO", "dateMention.remind", "dateMention.anchorId"].map { run.markAttrs[$0] }
        }
    }

    private func editDate(_ f: Fixture, to value: DateMentionValue) async throws {
        f.session.requestDateEdit(try drawnChip(f), in: f.field)
        f.session.applyDateEdit(.update(value))
        await f.session.tail?.value
    }

    /// #4762: the pane draws the edited chip from the block it re-reads, not
    /// the space the edit wrote, without the note being opened again.
    @Test(.timeLimit(.minutes(1))) func an_edited_date_is_drawn_in_its_pane_at_once() async throws {
        let f = try await fixtureWithDate()
        try await editDate(f, to: Self.moved)

        #expect(try await dates(f) == [[Self.moved.dateISO, "at", "dm_due"]])
        let chip = try drawnChip(f)
        #expect(chip.value == Self.moved)
        #expect(chip.anchorId == "dm_due")
    }

    /// #4762: the edit is one step. Undo puts the old date and its reminder
    /// back under the same anchor, redo the new one, and the pane draws each.
    @Test(.timeLimit(.minutes(1))) func a_date_edit_is_undone_and_redone_as_one_step() async throws {
        let f = try await fixtureWithDate()
        try await editDate(f, to: Self.moved)

        await undo(f)
        #expect(try await dates(f) == [[Self.due.dateISO, "1d", "dm_due"]])
        #expect(try await shown(f) == "hello \u{FFFC}")
        #expect(try drawnChip(f).value == Self.due)

        await redo(f)
        #expect(try await dates(f) == [[Self.moved.dateISO, "at", "dm_due"]])
        #expect(try await shown(f) == "hello \u{FFFC}")
        #expect(try drawnChip(f).value == Self.moved)

        await undo(f)
        #expect(try await dates(f) == [[Self.due.dateISO, "1d", "dm_due"]])
        #expect(!f.session.history.canUndo, "one step, not a text step beside it")
    }

    /// A chip with no anchor, from before anchors existed, is found by its
    /// place: rewritten there under the anchor the pane gave it, not added
    /// again at the end, and undone the same way.
    @Test(.timeLimit(.minutes(1))) func an_unanchored_date_is_rewritten_where_it_is() async throws {
        let f = try await fixtureWithDate(anchored: false)
        let anchor = try drawnChip(f).anchorId
        try await editDate(f, to: Self.moved)

        #expect(try await dates(f) == [[Self.moved.dateISO, "at", anchor]])
        #expect(try await shown(f) == "hello \u{FFFC}")
        #expect(f.model.status == .idle)

        await undo(f)
        #expect(try await dates(f) == [[Self.due.dateISO, "1d", anchor]])
    }
}
