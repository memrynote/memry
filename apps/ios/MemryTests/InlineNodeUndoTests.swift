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
        func blockText(noteId: String, blockId: String) async throws -> String? { throw ReadFailed() }
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
        func blockText(noteId: String, blockId: String) async throws -> String? {
            try await core.blockText(noteId: noteId, blockId: blockId)
        }
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
}
