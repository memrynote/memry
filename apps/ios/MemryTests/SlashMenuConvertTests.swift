//
//  SlashMenuConvertTests.swift
//  A slash row typed on a line that holds text: a text block type turns that
//  line, and everything else goes after it. Desktop's rule lives in
//  `slash-menu-convert.ts`; both read the Turn into list.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

@testable import Memry

private final class RecordingEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

@MainActor
struct SlashMenuConvertTests {
    private func line(_ text: String, kind: String = "paragraph") -> Block {
        let runs = text.isEmpty ? [] : [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
        return Block(id: "a", kind: kind, depth: 0, props: [], inline: runs)
    }

    /// Block `a` holds `text` then `/<query>`, already saved as typing saves
    /// it, and the row `id` is picked. `changes`: how many queued writes the
    /// row makes, each ending in a `didChange`. The session holds its field
    /// and model weakly, so the test holds them.
    private func pick(
        _ id: String, query: String, after text: String, kind: String = "paragraph", changes: Int
    ) async throws -> (edits: [BlockEdit], focus: String?) {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let typed = text + "/" + query
        let target = line(typed, kind: kind)
        session.blocks = { [target] }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: target, session: session, style: style, alignment: .natural)
        field.render()
        session.focusChanged(to: field)

        field.textView.text = text
        field.textView.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        field.typeKeys("/" + query)
        let suggestion = try #require(session.suggestions.first { $0.id == "slash:\(id)" })

        var seen = 0
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.reload = {
                seen += 1
                if seen == changes { done.resume() }
            }
            session.choose(suggestion)
        }
        withExtendedLifetime((field, model)) {}
        return (editor.all, session.pendingFocus)
    }

    private func inserted(_ edits: [BlockEdit]) -> [String] {
        edits.compactMap { if case let .insertBlock(kind, _, _, _) = $0 { kind } else { nil } }
    }

    @Test func aHeadingRowTurnsTheLineThatHoldsTextAndKeepsIt() async throws {
        let chosen = try await pick("heading_2", query: "h2", after: "Intro ", changes: 2)
        #expect(inserted(chosen.edits).isEmpty)
        // The space before the `/` goes with it, as on desktop.
        #expect(chosen.edits.contains(.replaceText(blockId: "a", text: "Intro", base: "Intro /h2")))
        #expect(chosen.edits.contains(.turnInto(blockId: "a", kind: "heading")))
        #expect(chosen.edits.contains(.setProp(blockId: "a", name: "level", value: "2")))
        #expect(chosen.focus == "a")
    }

    @Test func aChecklistRowTurnsTheLineIntoAPlainCheckbox() async throws {
        let chosen = try await pick("check_list", query: "check", after: "Milk ", changes: 2)
        #expect(inserted(chosen.edits).isEmpty)
        #expect(chosen.edits.contains(.turnInto(blockId: "a", kind: "checkListItem")))
        #expect(chosen.edits.contains(.setProp(blockId: "a", name: "plain", value: "true")))
    }

    @Test func everyTurnIntoTypeConvertsAndNothingElseDoes() {
        let converts = BlockCatalog.rows.filter(\.convertsInPlace).map(\.id)
        #expect(converts == [
            "paragraph", "heading", "heading_2", "heading_3", "bullet_list", "numbered_list",
            "check_list", "toggle_list", "quote", "callout", "code_block",
            "heading_4", "heading_5", "heading_6", "toggle_heading", "toggle_heading_2", "toggle_heading_3",
        ])
    }

    @Test func aDividerRowStillGoesAfterTheLine() async throws {
        let chosen = try await pick("divider", query: "div", after: "Intro ", changes: 1)
        // The divider, then the line the caret goes to.
        #expect(inserted(chosen.edits) == ["divider", "paragraph"])
        #expect(!chosen.edits.contains(.turnInto(blockId: "a", kind: "divider")))
    }

    @Test func aTableRowStillGoesAfterTheLine() async throws {
        let chosen = try await pick("table", query: "tab", after: "Intro ", changes: 1)
        #expect(inserted(chosen.edits) == ["table"])
    }

    /// One line on the real core, in a focused row that re-reads its block
    /// after every write, as the page does (`updateUIView`).
    @MainActor private struct OnCore {
        let vault: TasksTestVault
        let model: NoteEditorViewModel
        let reader: CoreNotesReader
        let field: BlockField
        let noteId: String
        let blockId: String
        var session: EditorSession { model.session }

        /// The block as the core holds it: its type, then its text.
        func line() async throws -> String {
            let blocks = try #require(try await reader.blocks(id: noteId))
            session.blocks = { blocks }
            let block = try #require(blocks.first { $0.id == blockId })
            return "\(block.kind) \(BlockText.shown(block.inline))"
        }

        /// The type and level the toolbar's Turn into shows.
        var shown: String {
            "\(session.focusedKind ?? "none") \(session.focusedLevel.map(String.init) ?? "-")"
        }

        func settle() async {
            session.enqueue {}
            await session.tail?.value
        }
    }

    private func onCore(_ kind: String, _ text: String, level: Int? = nil) async throws -> OnCore {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Slash", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        _ = try writer.editBlock(
            noteId: noteId, edit: .insertBlock(kind: kind, afterBlockId: nil, text: text, newBlockId: blockId)
        )
        if let level {
            _ = try writer.editBlock(noteId: noteId, edit: .setProp(blockId: blockId, name: "level", value: String(level)))
        }
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        let session = model.session
        session.model = model
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let block = try #require(try await reader.blocks(id: noteId)?.first { $0.id == blockId })
        session.blocks = { [block] }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: session, style: style, alignment: .natural)
        field.render()
        session.focusChanged(to: field)
        session.reload = { [weak session, weak field] in
            guard let session, let field else { return }
            let generation = session.landedWrites
            guard let read = try? await reader.blocks(id: noteId)?.first(where: { $0.id == blockId }) else { return }
            field.receive(read, generation: generation)
        }
        return OnCore(vault: vault, model: model, reader: reader, field: field, noteId: noteId, blockId: blockId)
    }

    /// On the real core: undo puts the line back as it was before the `/`,
    /// in one step, and redo turns it again (desktop's
    /// `slash-menu-convert.integration.test.ts` holds desktop to the same).
    /// The toolbar's Turn into follows: a bullet and a numbered item share
    /// one text view, so no new row takes the caret to read the type.
    @Test(.timeLimit(.minutes(1))) func undoPutsTheLineBackAsItWasBeforeTheSlashAndRedoTurnsItAgain() async throws {
        let core = try await onCore("bulletListItem", "Milk /numbered")
        let field = core.field
        field.textView.text = "Milk "
        field.textView.selectedRange = NSRange(location: 5, length: 0)
        field.typeKeys("/numbered")
        core.session.choose(try #require(core.session.suggestions.first { $0.id == "slash:numbered_list" }))
        await core.settle()
        #expect(try await core.line() == "numberedListItem Milk")
        #expect(core.shown == "numberedListItem -")

        core.session.undo()
        await core.settle()
        #expect(try await core.line() == "bulletListItem Milk")
        #expect(core.shown == "bulletListItem -")

        core.session.redo()
        await core.settle()
        #expect(try await core.line() == "numberedListItem Milk")
        #expect(core.shown == "numberedListItem -")
        withExtendedLifetime(core) {}
    }

    /// The block menu's and the toolbar's Turn into: undo and redo bring the
    /// heading's level back in the toolbar too, as in the block.
    @Test(.timeLimit(.minutes(1))) func undoAndRedoOfATurnIntoShowTheLevelTheLineHas() async throws {
        let core = try await onCore("heading", "Plan", level: 1)
        core.session.turnInto(try #require(InsertableBlock.all.first { $0.kind == "heading" && $0.level == 2 }))
        await core.settle()
        #expect(core.shown == "heading 2")

        core.session.undo()
        await core.settle()
        #expect(core.shown == "heading 1")

        core.session.redo()
        await core.settle()
        #expect(core.shown == "heading 2")
        withExtendedLifetime(core) {}
    }

    @Test func aRowOnAnEmptyLineStillTurnsIt() async throws {
        let chosen = try await pick("quote", query: "quo", after: "", changes: 2)
        #expect(inserted(chosen.edits).isEmpty)
        #expect(chosen.edits.contains(.turnInto(blockId: "a", kind: "quote")))
    }
}
