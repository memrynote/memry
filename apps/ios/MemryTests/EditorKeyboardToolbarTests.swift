//
//  EditorKeyboardToolbarTests.swift
//  The keyboard toolbar's decisions: the `#` menu, the hashTag node, the
//  block an uploaded attachment becomes, the row's order, the format slide,
//  the focused block's indent and moves, Move to, and the `+` grid that
//  shares the slash menu's catalog.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit
import UniformTypeIdentifiers

@testable import Memry

private final class ScriptedToolbarEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

/// `#tag` typed as text reads as a tag where desktop's `HASH_TAG_PATTERN`
/// does: after whitespace or at the start, and nowhere inside a word.
struct HashTagTextTests {
    @Test func aTagAfterSpaceOrAtTheStartIsFound() {
        let found = HashTagText.matches(in: "#movie and #movies/sci-fi.")
        #expect(found.map(\.tag) == ["movie", "movies/sci-fi"])
        #expect(found.first?.range == NSRange(location: 0, length: 6))
    }

    @Test func aHashInsideAWordOrBeforeNoTagCharacterIsNot() {
        #expect(HashTagText.matches(in: "c#sharp issue#4 # heading #-x").isEmpty)
    }
}

struct HashTagTriggerTests {
    @Test func aHashAtAWordStartOpensTheMenu() {
        #expect(HashTagTrigger.active(in: "#", caret: 1) == HashTagTrigger(range: NSRange(location: 0, length: 1), query: ""))
        #expect(HashTagTrigger.active(in: "note #wor", caret: 9) == HashTagTrigger(range: NSRange(location: 5, length: 4), query: "wor"))
        #expect(HashTagTrigger.active(in: "a\u{FFFC}#x", caret: 4)?.query == "x")
    }

    @Test func aHashInsideAWordOrPastASpaceDoesNot() {
        #expect(HashTagTrigger.active(in: "c#", caret: 2) == nil)
        #expect(HashTagTrigger.active(in: "# heading", caret: 9) == nil)
        #expect(HashTagTrigger.active(in: "#a.b", caret: 4) == nil)
        #expect(HashTagTrigger.active(in: "plain", caret: 5) == nil)
    }

    @Test func tagCharactersAreDesktops() {
        #expect(HashTagTrigger.active(in: "#work/q-1_x", caret: 11)?.query == "work/q-1_x")
    }
}

struct TagSuggestionsTests {
    @Test func prefixMatchesComeFirstThenACreateRow() {
        let rows = TagSuggestions.rank(query: "wo", tags: ["network", "work", "home"])
        #expect(rows.map(\.tag) == ["work", "network", "wo"])
        #expect(rows.last?.isNew == true)
    }

    @Test func anExactTagOffersNoCreateRow() {
        let rows = TagSuggestions.rank(query: "Work", tags: ["work"])
        #expect(rows == [TagSuggestion(tag: "work", isNew: false)])
    }

    @Test func anEmptyQueryListsTheVaultsTagsUpToTheLimit() {
        let tags = (0..<12).map { "t\($0)" }
        let rows = TagSuggestions.rank(query: "", tags: tags)
        #expect(rows.count == TagSuggestions.limit)
        #expect(rows.allSatisfy { !$0.isNew })
    }

    @Test func theNodeCarriesTheChosenColourOrTheHashedDefault() {
        #expect(HashTagAttrs.attrs(tag: "Work", colors: ["work": "blue"]) == ["tag": "Work", "color": "blue", "icon": ""])
        #expect(HashTagAttrs.attrs(tag: "home", colors: [:])["color"] == Tokens.Palette.defaultName(for: "home"))
    }
}

struct AttachmentBlockTests {
    @Test func aPictureIsAnImageBlockNamingItsFileRootRelative() {
        let block = AttachmentBlock.make(noteId: "n1", filename: "my photo.png", mimeType: "image/png", size: 10)
        #expect(block.kind == "image")
        #expect(block.props == [
            .init(name: "url", value: "attachments/n1/my%20photo.png"),
            .init(name: "caption", value: "my photo.png"),
            .init(name: "previewWidth", value: "600"),
        ])
    }

    @Test func aPdfIsAFileBlock() {
        let block = AttachmentBlock.make(noteId: "n1", filename: "scan.pdf", mimeType: "application/pdf", size: 42)
        #expect(block.kind == "file")
        #expect(block.props == [
            .init(name: "url", value: "attachments/n1/scan.pdf"),
            .init(name: "name", value: "scan.pdf"),
            .init(name: "size", value: "42"),
            .init(name: "mimeType", value: "application/pdf"),
        ])
    }

    @Test func aRecordingIsAFileBlockThatPlays() {
        let block = AttachmentBlock.make(noteId: "n1", filename: "ab12cd-memo.m4a", mimeType: "audio/x-m4a", size: 2048)
        #expect(block.kind == "file")
        #expect(block.props == [
            .init(name: "url", value: "attachments/n1/ab12cd-memo.m4a"),
            .init(name: "name", value: "ab12cd-memo.m4a"),
            .init(name: "size", value: "2048"),
            .init(name: "mimeType", value: "audio/x-m4a"),
        ])
        #expect(AttachmentBlock.media(kind: "file", mimeType: "audio/x-m4a") == "audio")
    }

    @Test func aVideoIsAFileBlockThatPlays() {
        let block = AttachmentBlock.make(noteId: "n1", filename: "ab12cd-clip.mp4", mimeType: "video/mp4", size: 1_048_576)
        #expect(block.kind == "file")
        #expect(block.props == [
            .init(name: "url", value: "attachments/n1/ab12cd-clip.mp4"),
            .init(name: "name", value: "ab12cd-clip.mp4"),
            .init(name: "size", value: "1048576"),
            .init(name: "mimeType", value: "video/mp4"),
        ])
        #expect(AttachmentBlock.media(kind: "file", mimeType: "video/mp4") == "video")
        #expect(AttachmentBlock.media(kind: "file", mimeType: "application/pdf") == nil)
        #expect(AttachmentBlock.media(kind: "video", mimeType: nil) == "video")
    }

    @Test func aLibraryVideoIsNamedAsACapture() {
        let date = Date(timeIntervalSince1970: 0)
        let payload = AttachmentPayload.video(Data([1]), type: .mpeg4Movie, at: date)
        #expect(payload.filename == "video-19700101T000000.mp4")
        #expect(payload.mimeType == "video/mp4")
        #expect(AttachmentPayload.video(Data([1]), type: .quickTimeMovie, at: date).mimeType == "video/quicktime")
    }

    @Test func aPictureDesktopDrawsKeepsItsBytes() {
        let bytes = Data([1, 2, 3])
        let payload = AttachmentPayload.picture(bytes, type: .png)
        #expect(payload.bytes == bytes)
        #expect(payload.mimeType == "image/png")
        #expect(payload.filename.hasSuffix(".png"))
    }

    @MainActor
    @Test func anUploadedAttachmentIsInsertedThenGivenItsProps() async {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.insertAttachment(AttachmentBlock.make(noteId: "n1", filename: "a.jpg", mimeType: "image/jpeg", size: 1))
        }
        let edits = editor.all
        #expect(edits.count == 4)
        guard case let .insertBlock(kind, after, _, newId) = edits.first else {
            Issue.record("expected an insert first")
            return
        }
        #expect(kind == "image")
        #expect(after == nil)
        #expect(edits.dropFirst().first == .setProp(blockId: newId, name: "url", value: "attachments/n1/a.jpg"))
    }

    @MainActor
    @Test func anInsertedAttachmentUndoesAndRedoesWithItsProps() async throws {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.insertAttachment(AttachmentBlock.make(noteId: "n1", filename: "a.pdf", mimeType: "application/pdf", size: 3))
        }
        guard case let .insertBlock(_, _, _, newId) = editor.all.first else {
            Issue.record("expected an insert first")
            return
        }
        let inserted = editor.all
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.undo()
        }
        #expect(editor.all.last == .delete(blockId: newId))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.redo()
        }
        #expect(Array(editor.all.suffix(5)) == inserted)
    }

    @Test func anUploadIsNamedAsDesktopNamesIt() {
        #expect(AttachmentFilename.unique("my photo (1).png", prefix: "abc123") == "abc123-my-photo-1.png")
        #expect(AttachmentFilename.unique("{a}.pdf", prefix: "abc123") == "abc123-a.pdf")
        #expect(AttachmentFilename.unique("().txt", prefix: "abc123") == "abc123-file.txt")
        #expect(AttachmentFilename.unique("report.tar.gz", prefix: "abc123") == "abc123-report.tar.gz")
        #expect(AttachmentFilename.unique("a:b#c.jpg", prefix: "abc123") == "abc123-abc.jpg")
        #expect(AttachmentFilename.unique(".env", prefix: "abc123") == "abc123-env")
        let first = AttachmentFilename.unique("photo.jpg")
        let second = AttachmentFilename.unique("photo.jpg")
        #expect(first.range(of: "^[0-9a-z]{6}-photo\\.jpg$", options: .regularExpression) != nil)
        #expect(first != second, "two uploads of one name do not collide")
    }

    @MainActor
    @Test func removingAMarkIsUndoable() async {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let block = Block(id: "a", kind: "paragraph", depth: 0, props: [], inline: [
            InlineRun(text: "hi", marks: ["bold"], markAttrs: [:], target: nil),
        ])
        let field = BlockField(block: block, session: session, style: style, alignment: .natural)
        field.render()
        session.focusChanged(to: field)
        field.textView.selectedRange = NSRange(location: 0, length: 2)
        session.selectionChanged(in: field)
        #expect(session.selectionMarks.contains("bold"))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.toggleMark("bold")
        }
        #expect(editor.all.last == .removeMark(blockId: "a", start: 0, end: 2, mark: "bold"))
        #expect(session.history.popUndo()?.backward == .setMark(blockId: "a", start: 0, end: 2, mark: "bold", value: nil))
    }

    @MainActor
    @Test func aValuedMarkIsRestoredWithItsValue() {
        let runs = [
            InlineRun(text: "ab", marks: ["textColor"], markAttrs: ["textColor": "red"], target: nil),
            InlineRun(text: "cd", marks: ["textColor"], markAttrs: ["textColor": "blue"], target: nil),
        ]
        #expect(EditorSession.markValue("textColor", in: runs, from: 0, to: 2) == .some("red"))
        #expect(EditorSession.markValue("textColor", in: runs, from: 1, to: 3) == nil, "two values: not restorable")
        #expect(EditorSession.markValue("bold", in: runs, from: 0, to: 2) == nil)
    }
}

private func block(
    _ id: String, depth: UInt32 = 0, kind: String = "paragraph", props: [String: String] = [:],
    inline: [InlineRun] = []
) -> Block {
    Block(id: id, kind: kind, depth: depth, props: props.map { BlockProp(name: $0.key, value: $0.value) }, inline: inline)
}

@MainActor
private func focused(_ target: Block, in blocks: [Block], session: EditorSession) -> BlockField {
    session.blocks = { blocks }
    let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
    let field = BlockField(block: target, session: session, style: style, alignment: .natural)
    field.render()
    session.focusChanged(to: field)
    return field
}

struct EditorToolbarOrderTests {
    @Test func aParagraphKeepsTheSpecOrder() {
        #expect(EditorToolbarItem.order(for: "paragraph") == [
            .insert, .format, .mention, .tag, .attach, .turnInto, .undo, .redo,
            .indent, .outdent, .moveDown, .moveUp, .more,
        ])
        #expect(EditorToolbarItem.order(for: nil) == EditorToolbarItem.allCases)
        #expect(EditorToolbarItem.order(for: "heading") == EditorToolbarItem.allCases)
    }

    @Test func aListItemLeadsWithItsMovesAndKeepsTheRestInOrder() {
        for kind in ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"] {
            #expect(EditorToolbarItem.order(for: kind) == [
                .indent, .outdent, .moveDown, .moveUp,
                .insert, .format, .mention, .tag, .attach, .turnInto, .undo, .redo, .more,
            ])
        }
    }

    @Test func everyItemAppearsOnce() {
        for kind in ["paragraph", "bulletListItem"] {
            let order = EditorToolbarItem.order(for: kind)
            #expect(Set(order).count == EditorToolbarItem.allCases.count)
            #expect(order.count == EditorToolbarItem.allCases.count)
        }
    }
}

@MainActor
struct EditorToolbarFocusTests {
    private func session() -> EditorSession {
        let model = NoteEditorViewModel(noteId: "n1", editor: ScriptedToolbarEditor())
        model.session.model = model
        return model.session
    }

    @Test func indentNeedsAPreviousSiblingAndOutdentANestedBlock() {
        let blocks = [block("a"), block("a1", depth: 1), block("a2", depth: 1), block("b", kind: "heading")]
        let session = session()
        _ = focused(blocks[0], in: blocks, session: session)
        #expect(!session.canIndent)
        #expect(!session.canOutdent)
        _ = focused(blocks[1], in: blocks, session: session)
        #expect(!session.canIndent, "the first child has nothing to nest under")
        #expect(session.canOutdent)
        _ = focused(blocks[2], in: blocks, session: session)
        #expect(session.canIndent)
        _ = focused(blocks[3], in: blocks, session: session)
        #expect(session.canIndent, "any block nests under its previous sibling, as BlockNote allows")
        #expect(session.focusedSiblings == BlockSiblings(previous: "a", next: nil))
    }

    @Test func aColumnsOwnBlockCannotOutdentButOneNestedInsideItCan() {
        let blocks = [
            Block(id: nil, kind: "columnList", depth: 0, props: [BlockProp(name: "id", value: "cl")], inline: []),
            Block(id: nil, kind: "column", depth: 1, props: [BlockProp(name: "id", value: "c1")], inline: []),
            block("a1", depth: 2),
            block("a2", depth: 3),
            Block(id: nil, kind: "column", depth: 1, props: [BlockProp(name: "id", value: "c2")], inline: []),
            block("b1", depth: 2),
        ]
        let session = session()
        _ = focused(blocks[2], in: blocks, session: session)
        #expect(!session.canOutdent, "the core refuses a column's own block, as desktop's liftItem does nothing")
        _ = focused(blocks[5], in: blocks, session: session)
        #expect(!session.canOutdent)
        _ = focused(blocks[3], in: blocks, session: session)
        #expect(session.canOutdent, "a block nested inside a column lifts within it")
    }

    @Test func aSelectionSlidesTheFormatRowInAndCollapsingItSlidesItOut() {
        let target = block("a", inline: [InlineRun(text: "hello", marks: [], markAttrs: [:], target: nil)])
        let session = session()
        let field = focused(target, in: [target], session: session)
        #expect(!session.formatting)
        field.textView.selectedRange = NSRange(location: 0, length: 3)
        session.selectionChanged(in: field)
        #expect(session.formatting)
        session.showFormatting(false)
        #expect(!session.formatting, "back returns to the main row while the selection stays")
        field.textView.selectedRange = NSRange(location: 2, length: 0)
        session.selectionChanged(in: field)
        #expect(!session.formatting)
        session.showFormatting(true)
        session.selectionChanged(in: field)
        #expect(session.formatting, "Aa stays open while the caret sits still")
    }

    @Test func moveToIsHiddenOnBlocksThatOwnAnAttachment() {
        let image = InlineRun(text: "", marks: ["inlineImage"], markAttrs: [:], target: nil)
        let blocks = [
            block("a"), block("a1", depth: 1, kind: "image"),
            block("b"),
            block("c", inline: [image]),
            block("d", kind: "file"),
        ]
        #expect(EditorSession.carriesAttachment(at: 0, in: blocks), "a nested image moves with its parent")
        #expect(!EditorSession.carriesAttachment(at: 2, in: blocks))
        #expect(EditorSession.carriesAttachment(at: 3, in: blocks))
        #expect(EditorSession.carriesAttachment(at: 4, in: blocks))
    }

    @Test func theTaskLinesThatMoveAreTheBlocksAndItsChildren() {
        let blocks = [
            block("a", kind: "taskBlock", props: ["taskId": "t1"]),
            block("a1", depth: 1, kind: "taskBlock", props: ["taskId": "t2"]),
            block("a2", depth: 1, kind: "taskBlock", props: ["taskId": ""]),
            block("b", kind: "taskBlock", props: ["taskId": "t3"]),
        ]
        #expect(EditorSession.taskIds(at: 0, in: blocks) == ["t1", "t2"])
        #expect(EditorSession.taskIds(at: 3, in: blocks) == ["t3"])
    }

    @Test func aMovedTaskLinksToItsNewNoteOnly() {
        #expect(NoteTaskLinks.relinked(["n1", "x"], unlink: "n1", link: "n2") == ["x", "n2"])
        #expect(NoteTaskLinks.relinked(["n2"], unlink: "n1", link: "n2") == ["n2"])
    }
}

@MainActor
struct InsertGridTests {
    @Test func theGridListsTheSlashMenusRowsInItsOrder() {
        let grid = BlockCatalog.sections(attach: true, inline: true).flatMap(\.rows).map(\.id)
        let slash = SlashMenu.suggestions(query: "", attach: true).map(\.id)
        let expected = [
            "paragraph", "heading", "heading_2", "heading_3", "bullet_list", "numbered_list",
            "check_list", "toggle_list", "quote", "callout", "code_block", "divider",
            "two_columns", "three_columns", "heading_4", "heading_5", "heading_6", "toggle_heading", "toggle_heading_2", "toggle_heading_3",
            "link_to_note", "date", "remind", "table", "math", "diagram", "bookmark", "youtube",
            "image", "video", "audio", "file",
        ]
        #expect(grid == expected)
        #expect(slash == expected.map { "slash:\($0)" })
        #expect(BlockCatalog.sections(attach: true, inline: true).map(\.section.title) == ["Basic", "Headings", "Insert", "Media"])
        #expect(BlockCatalog.sections(attach: false, inline: true).map(\.section.title) == ["Basic", "Headings", "Insert"])
    }

    @Test func aCodeBlockGridOffersBlocksButNoInlineRows() {
        let session = EditorSession()
        let code = block("c", kind: "codeBlock")
        let field = focused(code, in: [code], session: session)
        #expect(session.gridSections.flatMap(\.rows).map(\.id) == [
            "paragraph", "heading", "heading_2", "heading_3", "bullet_list", "numbered_list",
            "check_list", "toggle_list", "quote", "callout", "code_block", "divider",
            "two_columns", "three_columns", "heading_4", "heading_5", "heading_6", "toggle_heading", "toggle_heading_2", "toggle_heading_3",
            "table", "math", "diagram", "bookmark", "youtube",
        ])
        #expect(session.gridSections.map(\.section.title) == ["Basic", "Headings", "Insert"])

        let text = block("p")
        let paragraph = focused(text, in: [text], session: session)
        #expect(session.gridSections.flatMap(\.rows).map(\.id).suffix(8) == ["link_to_note", "date", "remind", "table", "math", "diagram", "bookmark", "youtube"])
        withExtendedLifetime((field, paragraph)) {}
    }

    @Test func eachMediaRowOpensItsPicker() async throws {
        let model = NoteEditorViewModel(noteId: "n1", editor: ScriptedToolbarEditor())
        let session = model.session
        var opened: [EditorAttachmentSource] = []
        let field = focused(block("a"), in: [block("a")], session: session)
        let rows = try ["image", "video", "audio", "file"].map { id in
            try #require(BlockCatalog.rows.first { $0.id == id })
        }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.attach = { source in
                opened.append(source)
                if opened.count == rows.count { done.resume() }
            }
            for row in rows { session.chooseFromGrid(row) }
        }
        withExtendedLifetime(field) {}
        #expect(opened == [.photos, .videos, .audio, .files])
    }

    @Test func aPickerOpensOnlyAfterTheOpenBlocksTypingIsWritten() async throws {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let field = focused(block("a"), in: [block("a")], session: session)
        field.textView.text = "typed"
        field.dirty = true
        let writtenBeforeOpen = await withCheckedContinuation { (done: CheckedContinuation<[BlockEdit], Never>) in
            session.attach = { _ in done.resume(returning: editor.all) }
            session.openAttachment(.files)
        }
        withExtendedLifetime(field) {}
        #expect(writtenBeforeOpen == [.setText(blockId: "a", text: "typed")])
    }

    @Test func mediaWordsFindTheMediaRows() {
        let rows = BlockCatalog.rows(attach: true)
        #expect(BlockCatalog.filter(rows, query: "mp3").map(\.id) == ["audio"])
        #expect(BlockCatalog.filter(rows, query: "attachment").map(\.id) == ["file"])
        #expect(BlockCatalog.filter(rows, query: "vid").map(\.id) == ["video", "divider", "youtube"])
    }

    /// `changes`: how many queued writes the row makes, each ending in a
    /// `didChange`. The session holds its field and model weakly, so the test
    /// holds them.
    private func choose(_ id: String, in target: Block, changes: Int = 1) async throws -> [BlockEdit] {
        try await chooseFocusing(id, in: target, changes: changes).edits
    }

    /// `focus`: the block the caret is sent to once the row has acted.
    private func chooseFocusing(
        _ id: String, in target: Block, changes: Int = 1
    ) async throws -> (edits: [BlockEdit], focus: String?) {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let row = try #require(BlockCatalog.rows.first { $0.id == id })
        let field = focused(target, in: [target], session: session)
        var seen = 0
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = {
                seen += 1
                if seen == changes { done.resume() }
            }
            session.chooseFromGrid(row)
        }
        withExtendedLifetime((field, model)) {}
        return (editor.all, session.pendingFocus)
    }

    @Test func aTableOnAnEmptyLineTurnsItIntoATableThatTakesTheCaret() async throws {
        let chosen = try await chooseFocusing("table", in: block("a"), changes: 2)
        #expect(chosen.edits == [.turnInto(blockId: "a", kind: "table")])
        #expect(chosen.focus == "a")
    }

    @Test func aTableAfterTextIsInsertedAfterItAndTakesTheCaret() async throws {
        let text = InlineRun(text: "hi", marks: [], markAttrs: [:], target: nil)
        let chosen = try await chooseFocusing("table", in: block("a", inline: [text]))
        guard case let .insertBlock(kind, after, _, newId) = chosen.edits.first else {
            Issue.record("expected an insert, got \(chosen.edits)")
            return
        }
        #expect(kind == "table")
        #expect(after == "a")
        #expect(chosen.edits.count == 1)
        #expect(chosen.focus == newId)
    }

    @Test func twoColumnsReplaceAnEmptyLineAndTheCaretWaitsForTheFirstColumn() async throws {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let row = try #require(BlockCatalog.rows.first { $0.id == "two_columns" })
        let field = focused(block("a"), in: [block("a")], session: session)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.chooseFromGrid(row)
        }
        withExtendedLifetime((field, model)) {}
        guard case let .insertColumnList(after, columns, listId) = editor.all.first else {
            Issue.record("expected a column list insert first, got \(editor.all)")
            return
        }
        #expect(after == "a")
        #expect(columns == 2)
        // Desktop replaces an empty paragraph with the list.
        #expect(Array(editor.all.dropFirst()) == [.delete(blockId: "a")])
        #expect(session.pendingColumnFocus == listId)

        // The redraw that shows the list hands the caret to column one.
        session.resolveColumnFocus(in: [
            Block(id: nil, kind: "columnList", depth: 0, props: [BlockProp(name: "id", value: listId)], inline: []),
            Block(id: nil, kind: "column", depth: 1, props: [BlockProp(name: "width", value: "1")], inline: []),
            block("p1", depth: 2),
        ])
        #expect(session.pendingFocus == "p1")
        #expect(session.pendingColumnFocus == nil)
    }

    @Test func threeColumnsAfterTextKeepTheLine() async throws {
        let text = InlineRun(text: "hi", marks: [], markAttrs: [:], target: nil)
        let edits = try await choose("three_columns", in: block("a", inline: [text]))
        guard case let .insertColumnList(after, columns, _) = edits.first else {
            Issue.record("expected a column list insert, got \(edits)")
            return
        }
        #expect(after == "a")
        #expect(columns == 3)
        #expect(edits.count == 1)
    }

    @Test func columnsChosenInsideAColumnKeepTheEmptyLine() async throws {
        // The core lands the new list after the one holding the caret, so
        // the caret's line is not the one the list replaces.
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let row = try #require(BlockCatalog.rows.first { $0.id == "two_columns" })
        let inColumn = block("x", depth: 2)
        let blocks = [
            Block(id: nil, kind: "columnList", depth: 0, props: [BlockProp(name: "id", value: "cl")], inline: []),
            Block(id: nil, kind: "column", depth: 1, props: [], inline: []),
            inColumn,
        ]
        let field = focused(inColumn, in: blocks, session: session)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.chooseFromGrid(row)
        }
        withExtendedLifetime((field, model)) {}
        #expect(editor.all.count == 1)
        guard case .insertColumnList(afterBlockId: "x"?, columns: 2, newBlockId: _) = editor.all.first else {
            Issue.record("expected only the insert, got \(editor.all)")
            return
        }
    }

    @Test func aToggleHeadingTurnsAnEmptyLineIntoATogglableHeading() async throws {
        let edits = try await choose("toggle_heading_2", in: block("a"), changes: 2)
        #expect(edits == [
            .turnInto(blockId: "a", kind: "heading"),
            .setProp(blockId: "a", name: "level", value: "2"),
            .setProp(blockId: "a", name: "isToggleable", value: "true"),
        ])
    }

    @Test func equationTurnsAnEmptyLineIntoAMathBlockAndOpensItsSource() async throws {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let row = try #require(BlockCatalog.rows.first { $0.id == "math" })
        let field = focused(block("a"), in: [block("a")], session: session)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.chooseFromGrid(row)
        }
        withExtendedLifetime((field, model)) {}
        #expect(editor.all == [.turnInto(blockId: "a", kind: "mathBlock")])
        #expect(session.sourceEdit == BlockSourceRequest(blockId: "a", source: ""))
    }

    @Test func diagramTurnsAnEmptyLineIntoADiagramAndOpensItsSource() async throws {
        let editor = ScriptedToolbarEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let row = try #require(BlockCatalog.rows.first { $0.id == "diagram" })
        let field = focused(block("a"), in: [block("a")], session: session)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.chooseFromGrid(row)
        }
        withExtendedLifetime((field, model)) {}
        #expect(editor.all == [.turnInto(blockId: "a", kind: "diagram")])
        #expect(session.sourceEdit == BlockSourceRequest(blockId: "a", source: "", kind: .diagram))
    }

    @Test func aCheckListAfterTextIsAPlainCheckbox() async throws {
        let text = InlineRun(text: "hi", marks: [], markAttrs: [:], target: nil)
        let edits = try await choose("check_list", in: block("a", inline: [text]))
        guard case let .insertBlock(kind, after, _, newId) = edits.first else {
            Issue.record("expected an insert first, got \(edits)")
            return
        }
        #expect(kind == "checkListItem")
        #expect(after == "a")
        #expect(Array(edits.dropFirst()) == [.setProp(blockId: newId, name: "plain", value: "true")])
    }
}

/// An editor that reads snapshots and appends them, as the core does.
private final class MovingEditor: BlockEditing, @unchecked Sendable {
    let log = Mutex<[String]>([])
    let appends: Bool

    init(appends: Bool) {
        self.appends = appends
    }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        log.withLock { $0.append("edit \(noteId) \(edit)") }
        return true
    }

    func snapshot(noteId: String, blockId: String) async throws -> String? {
        log.withLock { $0.append("snapshot \(noteId) \(blockId)") }
        return "snap-\(blockId)"
    }

    var movesBlocksBetweenNotes: Bool { true }

    func appendSnapshot(_ snapshot: String, toNote noteId: String) async throws -> Bool {
        log.withLock { $0.append("append \(noteId) \(snapshot)") }
        return appends
    }

    var all: [String] { log.withLock { $0 } }
}

@MainActor
struct MoveBlockToNoteTests {
    private func move(appends: Bool) async -> (MovingEditor, EditorSession, [String]) {
        let editor = MovingEditor(appends: appends)
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let blocks = [block("a", kind: "taskBlock", props: ["taskId": "t1"]), block("b")]
        _ = focused(blocks[0], in: blocks, session: session)
        var relinked: [String] = []
        session.relinkTask = { taskId, target in relinked.append("\(taskId)->\(target)") }
        #expect(session.canMoveToNote)
        session.requestMoveToNote()
        #expect(session.moveRequest == BlockMoveRequest(blockId: "a"))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.moveToNote("n2")
        }
        return (editor, session, relinked)
    }

    @Test func theBlockIsAppendedToTheTargetThenRemovedHere() async {
        let (editor, session, relinked) = await move(appends: true)
        #expect(editor.all == [
            "snapshot n1 a",
            "append n2 snap-a",
            "edit n1 \(BlockEdit.delete(blockId: "a"))",
        ])
        #expect(session.moveRequest == nil)
        #expect(session.moveFailure == nil)
        #expect(relinked == ["t1->n2"])
    }

    @Test func aFailedAppendKeepsTheBlockAndSaysWhy() async {
        let (editor, session, relinked) = await move(appends: false)
        #expect(editor.all == ["snapshot n1 a", "append n2 snap-a"])
        #expect(session.moveFailure == ErrorMapping.unknownNote)
        #expect(relinked.isEmpty)
    }

    @Test func aSurfaceThatCannotMoveBlocksOffersNoMoveTo() {
        let model = NoteEditorViewModel(noteId: "n1", editor: ScriptedToolbarEditor())
        model.session.model = model
        let target = block("a")
        _ = focused(target, in: [target], session: model.session)
        #expect(!model.session.canMoveToNote)
    }

    @Test func thePickerSearchesTitlesAndFolders() {
        func note(_ id: String, _ title: String, folder: String? = nil) -> NoteSummary {
            NoteSummary(
                id: id, title: title, folderPath: folder, emoji: nil, createdAt: nil, modifiedAt: nil
            )
        }
        let notes = [note("1", "Groceries"), note("2", "Plans", folder: "Work/Q3"), note("3", "Ideas")]
        #expect(MoveBlockPicker.matches(notes, query: "").map(\.id) == ["1", "2", "3"])
        #expect(MoveBlockPicker.matches(notes, query: "gro").map(\.id) == ["1"])
        #expect(MoveBlockPicker.matches(notes, query: "work").map(\.id) == ["2"])
    }
}
