//
//  LinkBlockTests.swift
//  The Bookmark and YouTube rows: desktop's video id rule on desktop's own
//  fixtures, the props each block starts with, and the insert, undo and redo
//  the link sheet drives.
//

import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

private final class RecordingEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

struct YouTubeLinkTests {
    /// `packages/shared/src/youtube.test.ts`, verbatim.
    @Test(arguments: [
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://music.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ])
    func desktopsSupportedShapesGiveTheId(address: String, id: String) {
        #expect(YouTubeLink.videoId(address) == id)
    }

    @Test(arguments: [
        "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=too-short",
        "not a url",
    ])
    func desktopsRejectedAddressesGiveNoId(address: String) {
        #expect(YouTubeLink.videoId(address) == nil)
    }

    @Test(arguments: [
        ("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?t=90&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://WWW.YouTube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ])
    func aTimestampOrSharingParameterIsNotPartOfTheId(address: String, id: String) {
        #expect(YouTubeLink.videoId(address) == id)
    }
}

struct LinkBlockMakeTests {
    @Test func aVideoLinkBecomesAnEmbedWithItsIdAndAddress() {
        let block = LinkBlock.make(.youtube, from: "  https://youtu.be/dQw4w9WgXcQ?t=42\n")
        #expect(block == LinkBlock(
            kind: "youtubeEmbed",
            props: ["videoId": "dQw4w9WgXcQ", "videoUrl": "https://youtu.be/dQw4w9WgXcQ?t=42"]
        ))
    }

    @Test func aPageLinkIsNoVideo() {
        #expect(LinkBlock.make(.youtube, from: "https://example.com/watch?v=dQw4w9WgXcQ") == nil)
    }

    /// Title, description and image stay empty for desktop to fetch, as
    /// desktop's own insert leaves them.
    @Test func aBookmarkKeepsTheAddressAndTheDomainWithoutWww() {
        #expect(LinkBlock.make(.bookmark, from: "https://www.example.com/a?b=1") == LinkBlock(
            kind: "bookmark",
            props: ["domain": "example.com", "url": "https://www.example.com/a?b=1"]
        ))
    }

    @Test(arguments: ["example.com", "ftp://example.com/file", "https://", "https://exa mple.com", "not a url"])
    func onlyAnHttpAddressMakesABookmark(address: String) {
        #expect(LinkBlock.make(.bookmark, from: address) == nil)
    }

    @Test func thePasteButtonFillsTheFieldWithTheFirstPastedText() {
        #expect(LinkBlock.pasted(["  https://youtu.be/dQw4w9WgXcQ\n", "https://example.com"]) == "https://youtu.be/dQw4w9WgXcQ")
        #expect(LinkBlock.pasted(["", " ", "https://example.com"]) == "https://example.com")
        #expect(LinkBlock.pasted([]) == nil)
    }

    @Test func aVideoLinkInTheBookmarkSheetStaysABookmark() {
        #expect(LinkBlock.make(.bookmark, from: "https://youtu.be/dQw4w9WgXcQ")?.kind == "bookmark")
    }
}

@MainActor
struct LinkBlockInsertTests {
    private func insert(_ block: LinkBlock, model: NoteEditorViewModel) async {
        let session = model.session
        session.requestLink(.youtube)
        #expect(session.linkRequest == LinkBlockRequest(kind: .youtube, after: nil))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.insertLink(block)
        }
        #expect(session.linkRequest == nil)
    }

    @Test func theSheetsBlockIsInsertedThenGivenItsProps() async throws {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        model.session.model = model
        let block = try #require(LinkBlock.make(.youtube, from: "https://youtu.be/dQw4w9WgXcQ"))
        await insert(block, model: model)

        guard case let .insertBlock(kind, after, text, newId) = editor.all.first else {
            Issue.record("expected an insert first, got \(editor.all)")
            return
        }
        #expect(kind == "youtubeEmbed")
        #expect(after == nil)
        #expect(text == "")
        #expect(Array(editor.all.dropFirst()) == [
            .setProp(blockId: newId, name: "videoId", value: "dQw4w9WgXcQ"),
            .setProp(blockId: newId, name: "videoUrl", value: "https://youtu.be/dQw4w9WgXcQ"),
        ])
    }

    @Test func undoDeletesTheBlockAndRedoBringsItBackWithItsProps() async throws {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        let block = try #require(LinkBlock.make(.youtube, from: "https://youtu.be/dQw4w9WgXcQ"))
        await insert(block, model: model)
        let inserted = editor.all
        guard case let .insertBlock(_, _, _, newId) = inserted.first else {
            Issue.record("expected an insert first, got \(inserted)")
            return
        }

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.undo()
        }
        #expect(editor.all.last == .delete(blockId: newId))

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.didChange = { done.resume() }
            session.redo()
        }
        #expect(Array(editor.all.suffix(3)) == inserted)
    }

    @Test func cancellingLeavesTheBodyAlone() {
        let editor = RecordingEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        model.session.model = model
        model.session.requestLink(.bookmark)
        model.session.cancelLink()
        model.session.insertLink(LinkBlock(kind: "bookmark", props: ["url": "https://example.com"]))
        #expect(model.session.linkRequest == nil)
        #expect(editor.all.isEmpty)
    }
}
