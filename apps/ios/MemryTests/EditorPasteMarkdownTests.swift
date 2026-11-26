//
//  EditorPasteMarkdownTests.swift
//  Plain text with more than one line pasted into a block becomes the
//  blocks its markdown makes, as desktop's paste reads `text/plain`, through
//  the text view's own paste on the real core. Undo takes the paste back in
//  one step, and redo puts the same blocks back.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

@Suite("Pasted markdown becomes blocks", .serialized)
@MainActor
struct EditorPasteMarkdownTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let reader: CoreNotesReader
        let model: NoteEditorViewModel
    }

    private static let report = """
    # Coral Reef Bleaching
    ## Why it happens
    **Primary drivers:**
    1. **Ocean warming** — heat stress
    2. **Acidification** — lower pH

    ---
    """

    /// A note whose body is one block of `text`.
    private func fixture(text: String) throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let noteId = try writer.create(title: "Agent Paste", folderPath: nil)
        _ = try writer.editBlock(
            noteId: noteId,
            edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: text, newBlockId: UUID().uuidString.lowercased())
        )
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: noteId, editor: editor)
        model.session.model = model
        return Fixture(vault: vault, noteId: noteId, reader: CoreNotesReader(vault: vault.vault, executor: .shared), model: model)
    }

    private func blocks(_ f: Fixture) async throws -> [Block] {
        let blocks = try #require(try await f.reader.blocks(id: f.noteId))
        f.model.session.blocks = { blocks }
        return blocks
    }

    private func draw(_ block: Block, in f: Fixture, caret: Int) -> BlockField {
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: f.model.session, style: style, alignment: .natural)
        field.render()
        field.textView.selectedRange = NSRange(location: caret, length: 0)
        return field
    }

    private func settle(_ f: Fixture) async {
        f.model.session.enqueue {}
        await f.model.session.tail?.value
    }

    private func shown(_ blocks: [Block]) -> [String] {
        blocks.map { "\($0.kind) \(BlockText.shown($0.inline))" }
    }

    @Test(.timeLimit(.minutes(1))) func a_markdown_document_pasted_into_an_empty_block_becomes_blocks() async throws {
        let f = try fixture(text: "")
        let before = try await blocks(f)
        let field = draw(before[0], in: f, caret: 0)

        UIPasteboard.general.string = Self.report
        field.textView.paste(nil)
        await settle(f)
        let pasted = try await blocks(f)
        #expect(shown(pasted) == [
            "heading Coral Reef Bleaching",
            "heading Why it happens",
            "paragraph Primary drivers:",
            "numberedListItem Ocean warming — heat stress",
            "numberedListItem Acidification — lower pH",
            "divider ",
        ])
        #expect(pasted.dropFirst(2).first?.inline.first?.marks.contains("bold") == true, "a bold run stays bold")

        f.model.session.undo()
        await settle(f)
        #expect(shown(try await blocks(f)) == shown(before), "one undo takes the whole paste back")

        f.model.session.redo()
        await settle(f)
        let redone = try await blocks(f)
        #expect(shown(redone) == shown(pasted))
        #expect(redone.map(\.id) == pasted.map(\.id), "redo makes the same blocks again")
    }

    /// An assistant's answer copied as markdown: each construct is the block
    /// desktop builds from it, none of its source lines is left as text.
    private static let assistantAnswer = """
    | Name | Value |
    |---|---|
    | alpha | 1 |

    > [!note]
    > Callout body

    $$
    E = mc^2
    $$

    ![chart](https://example.com/c.png)

    <details data-memry-toggle>
    <summary>Toggle title</summary>

    Hidden body

    </details>

    ```mermaid
    graph TD
    ```
    """

    @Test(.timeLimit(.minutes(1))) func tables_callouts_math_images_toggles_and_diagrams_paste_as_blocks() async throws {
        let f = try fixture(text: "")
        let field = draw(try await blocks(f)[0], in: f, caret: 0)

        UIPasteboard.general.string = Self.assistantAnswer
        field.textView.paste(nil)
        await settle(f)
        let pasted = try await blocks(f)
        let kinds = pasted.map(\.kind)
        for kind in ["table", "callout", "mathBlock", "image", "toggleListItem", "diagram"] {
            #expect(kinds.contains(kind), "\(kind) missing from \(kinds)")
        }
        let literal = shown(pasted).filter { line in
            ["| Name", "[!note]", "$$", "![chart]", "<details", "```"].contains { line.contains($0) }
        }
        #expect(literal.isEmpty, "source lines left as text: \(literal)")
        #expect(shown(pasted).contains("callout Callout body"))
        #expect(shown(pasted).contains("toggleListItem Toggle title"))
    }

    @Test(.timeLimit(.minutes(1))) func the_text_after_the_caret_goes_below_the_pasted_blocks() async throws {
        let f = try fixture(text: "abcd")
        let field = draw(try await blocks(f)[0], in: f, caret: 2)

        UIPasteboard.general.string = "# x\r\n- y"
        field.textView.paste(nil)
        await settle(f)
        #expect(shown(try await blocks(f)) == ["paragraph ab", "heading x", "bulletListItem y", "paragraph cd"])

        f.model.session.undo()
        await settle(f)
        #expect(shown(try await blocks(f)) == ["paragraph abcd"], "undo joins the block back")
    }
}
