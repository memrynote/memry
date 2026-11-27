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

    /// On the real core: undo puts the line back as it was before the `/`,
    /// in one step, and redo turns it again (desktop's
    /// `slash-menu-convert.integration.test.ts` holds desktop to the same).
    @Test(.timeLimit(.minutes(1))) func undoPutsTheLineBackAsItWasBeforeTheSlashAndRedoTurnsItAgain() async throws {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Slash", folderPath: nil)
        let blockId = UUID().uuidString.lowercased()
        let typed = "Milk /numbered"
        _ = try writer.editBlock(
            noteId: noteId, edit: .insertBlock(kind: "bulletListItem", afterBlockId: nil, text: typed, newBlockId: blockId)
        )
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        let session = model.session
        session.model = model
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        func line() async throws -> String {
            let blocks = try #require(try await reader.blocks(id: noteId))
            session.blocks = { blocks }
            let block = try #require(blocks.first { $0.id == blockId })
            return "\(block.kind) \(BlockText.shown(block.inline))"
        }
        func settle() async {
            session.enqueue {}
            await session.tail?.value
        }

        _ = try await line()
        let block = try #require(session.blocks().first)
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: session, style: style, alignment: .natural)
        field.render()
        session.focusChanged(to: field)
        field.textView.text = "Milk "
        field.textView.selectedRange = NSRange(location: 5, length: 0)
        field.typeKeys("/numbered")
        session.choose(try #require(session.suggestions.first { $0.id == "slash:numbered_list" }))
        await settle()
        #expect(try await line() == "numberedListItem Milk")

        session.undo()
        await settle()
        #expect(try await line() == "bulletListItem Milk")

        session.redo()
        await settle()
        #expect(try await line() == "numberedListItem Milk")
        withExtendedLifetime((field, model, vault)) {}
    }

    @Test func aRowOnAnEmptyLineStillTurnsIt() async throws {
        let chosen = try await pick("quote", query: "quo", after: "", changes: 2)
        #expect(inserted(chosen.edits).isEmpty)
        #expect(chosen.edits.contains(.turnInto(blockId: "a", kind: "quote")))
    }
}
