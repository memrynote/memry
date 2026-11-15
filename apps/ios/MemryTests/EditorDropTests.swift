//
//  EditorDropTests.swift
//  #4357. Drops into a note's body, through the block's own drop delegates
//  and the real core: a dragged note becomes the `[[` menu's wiki link at the
//  drop point, a dropped file goes through the pickers' upload into a block
//  after the block under the drop, and typing not yet committed is kept.
//

import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit
import UniformTypeIdentifiers

@testable import Memry

/// A drop session the system would hand a drop delegate.
private final class FakeDropSession: NSObject, @preconcurrency UIDropSession {
    let items: [UIDragItem]
    init(_ providers: [NSItemProvider]) { items = providers.map(UIDragItem.init(itemProvider:)) }
    var localDragSession: (any UIDragSession)? { nil }
    var progressIndicatorStyle: UIDropSessionProgressIndicatorStyle = .default
    var progress: Progress { Progress() }
    func loadObjects(
        ofClass aClass: any NSItemProviderReading.Type, completion: @escaping ([any NSItemProviderReading]) -> Void
    ) -> Progress { Progress() }
    func location(in view: UIView) -> CGPoint { .zero }
    var allowsMoveOperation: Bool { true }
    var isRestrictedToDraggingApplication: Bool { false }
    func hasItemsConforming(toTypeIdentifiers typeIdentifiers: [String]) -> Bool {
        items.contains { item in typeIdentifiers.contains { item.itemProvider.hasItemConformingToTypeIdentifier($0) } }
    }
    func canLoadObjects(ofClass aClass: any NSItemProviderReading.Type) -> Bool {
        items.contains { $0.itemProvider.canLoadObject(ofClass: aClass) }
    }
}

/// A drop on a text view, at a caret position.
private final class FakeTextDrop: NSObject, @preconcurrency UITextDropRequest {
    let dropPosition: UITextPosition
    let suggestedProposal = UITextDropProposal(operation: .copy)
    let isSameView = false
    let dropSession: any UIDropSession
    init(at position: UITextPosition, _ providers: [NSItemProvider]) {
        dropPosition = position
        dropSession = FakeDropSession(providers)
    }
}

/// The attachment upload, answered without a server.
private final class DropUploader: VaultFilling, @unchecked Sendable {
    private let failure: (any Error)?
    /// A suggested name whose upload is refused, the rest go through.
    private let refusing: String?
    private let uploads = Mutex<[String]>([])
    init(failure: (any Error)? = nil, refusing: String? = nil) {
        self.failure = failure
        self.refusing = refusing
    }
    var uploaded: [String] { uploads.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(progress: @escaping @MainActor @Sendable (SyncProgress) -> Void) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
    func uploadAttachment(noteId: String, filename: String, mimeType: String, bytes: Data) async throws -> String {
        if let failure { throw failure }
        if let refusing, filename.hasSuffix("-\(refusing).png") { throw SyncError.Locked }
        uploads.withLock { $0.append("\(filename)|\(mimeType)") }
        return "att-\(filename)"
    }
    func detachAttachment(noteId: String, attachmentId: String) async throws {}
}

@Suite("Editor drops", .serialized)
@MainActor
struct EditorDropTests {
    private struct Fixture {
        let vault: TasksTestVault
        let source: String
        let target: String
        let second: String
        let reader: CoreNotesReader
        let model: NoteEditorViewModel
        let field: BlockField
        @MainActor var session: EditorSession { model.session }
    }

    /// A note holding one paragraph, "see ", open in an editor over the real
    /// core, and two notes, "Agent Dune" and "Dune Messiah", to drag into it.
    private func fixture() async throws -> Fixture {
        let vault = try TasksTestVault()
        let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
        let source = try writer.create(title: "Reading", folderPath: nil)
        let target = try writer.create(title: "Agent Dune", folderPath: nil)
        let second = try writer.create(title: "Dune Messiah", folderPath: nil)
        _ = try writer.editBlock(
            noteId: source,
            edit: .insertBlock(kind: "paragraph", afterBlockId: nil, text: "see ", newBlockId: "p1")
        )
        let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
        let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
        let model = NoteEditorViewModel(noteId: source, editor: editor)
        model.session.model = model
        model.session.linkNotes = try await reader.list()
        let block = try #require(try await reader.blocks(id: source)?.first)
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
        field.render()
        return Fixture(vault: vault, source: source, target: target, second: second, reader: reader, model: model, field: field)
    }

    private func noteProvider(_ f: Fixture, _ id: String? = nil) async throws -> NSItemProvider {
        let note = try #require(try await f.reader.list().first { $0.id == (id ?? f.target) })
        return NoteDrag.provider(for: note, vaultId: "vault-test") { nil }
    }

    /// Drops through the text view's drop delegate at `offset`, and waits for
    /// the writes to land.
    private func drop(_ providers: [NSItemProvider], at offset: Int, on f: Fixture) async throws {
        let textView = f.field.textView
        let position = try #require(textView.position(from: textView.beginningOfDocument, offset: offset))
        let request = FakeTextDrop(at: position, providers)
        let proposal = f.field.textDroppableView(textView, proposalForDrop: request)
        #expect(proposal.dropPerformer == .delegate, "the drop is the editor's, not the text view's")
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            f.session.reload = { done.resume() }
            f.field.textDroppableView(textView, willPerformDrop: request)
        }
    }

    private func blocks(_ f: Fixture) async throws -> [Block] {
        try #require(try await f.reader.blocks(id: f.source))
    }

    @Test func a_dropped_note_is_stored_as_the_wiki_link_the_menu_inserts() async throws {
        let f = try await fixture()

        try await drop([try await noteProvider(f)], at: 4, on: f)

        let runs = try await blocks(f).flatMap(\.inline)
        let links = runs.filter { $0.marks.contains("wikiLink") }
        #expect(links.map(\.target) == ["Agent Dune"])
        #expect(BlockText.shown(runs) == "see \u{FFFC} ")
        let menu = EditorSuggestions.wiki(query: "Agent Dune", notes: f.session.linkNotes).first?.kind
        #expect(menu == EditorSuggestions.link(to: f.target, in: f.session.linkNotes), "the menu's row for that note")
    }

    @Test func a_note_dropped_into_a_block_with_typing_keeps_the_typing() async throws {
        let f = try await fixture()
        f.session.focusChanged(to: f.field)
        // Typed, not yet committed.
        f.field.textView.textStorage.append(NSAttributedString(string: "chapter one"))
        f.field.dirty = true

        try await drop([try await noteProvider(f)], at: 15, on: f)

        let runs = try await blocks(f).flatMap(\.inline)
        #expect(BlockText.shown(runs) == "see chapter one \u{FFFC} ", "the typing first, then a space, the link and a space")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Agent Dune"])
        #expect(!f.field.dirty)
    }

    /// The commit draws a typed `[[Foo]]` as its one-character node before
    /// the dropped link goes in, so the link and the caret count from that.
    @Test func a_note_dropped_after_a_typed_link_lands_at_the_drop_point() async throws {
        let f = try await fixture()
        f.session.focusChanged(to: f.field)
        f.field.textView.textStorage.append(NSAttributedString(string: "[[Foo]] and "))
        f.field.dirty = true

        try await drop([try await noteProvider(f)], at: 16, on: f)

        let runs = try await blocks(f).flatMap(\.inline)
        #expect(BlockText.shown(runs) == "see \u{FFFC} and \u{FFFC} ")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo", "Agent Dune"])
        #expect(f.field.pendingSelection == NSRange(location: 12, length: 0), "the caret after the dropped link's space")
    }

    @Test func a_link_chosen_after_a_typed_link_lands_where_the_query_was() async throws {
        let f = try await fixture()
        f.session.focusChanged(to: f.field)
        f.field.textView.textStorage.append(NSAttributedString(string: "[[Foo]] and [[Agent"))
        f.field.dirty = true
        f.field.textView.selectedRange = NSRange(location: 23, length: 0)
        f.session.selectionChanged(in: f.field)
        let row = try #require(f.session.suggestions.first { $0.kind == .note(title: "Agent Dune", alias: "") })

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            f.session.reload = { done.resume() }
            f.session.choose(row)
        }

        let runs = try await blocks(f).flatMap(\.inline)
        #expect(BlockText.shown(runs) == "see \u{FFFC} and \u{FFFC} ")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Foo", "Agent Dune"])
        #expect(f.field.pendingSelection == NSRange(location: 12, length: 0))
    }

    @Test func two_notes_dragged_together_are_both_linked_in_order() async throws {
        let f = try await fixture()

        try await drop([try await noteProvider(f), try await noteProvider(f, f.second)], at: 4, on: f)

        let runs = try await blocks(f).flatMap(\.inline)
        #expect(BlockText.shown(runs) == "see \u{FFFC} \u{FFFC} ", "space-separated")
        #expect(runs.filter { $0.marks.contains("wikiLink") }.map(\.target) == ["Agent Dune", "Dune Messiah"])
        #expect(f.field.pendingSelection == NSRange(location: 8, length: 0), "the caret after the last")
    }

    @Test func a_dragged_note_this_vault_does_not_list_is_reported() async throws {
        let f = try await fixture()
        let provider = try await noteProvider(f)
        f.session.linkNotes = f.session.linkNotes.filter { $0.id != f.target }

        await f.session.dropNotes([provider], at: 4, in: f.field)

        #expect(f.session.failure?.code == ErrorMapping.notesNotLinked(1).code)
        #expect(BlockText.shown(try await blocks(f).flatMap(\.inline)) == "see ")
    }

    @Test func a_note_is_not_dropped_into_a_code_block() async throws {
        let f = try await fixture()
        let code = Block(id: "c", kind: "codeBlock", depth: 0, props: [], inline: [])
        let field = BlockField(block: code, session: f.session, style: f.field.style, alignment: .natural)
        let request = FakeTextDrop(at: field.textView.beginningOfDocument, [try await noteProvider(f)])

        #expect(field.textDroppableView(field.textView, proposalForDrop: request).operation == .forbidden)
    }

    // MARK: Files

    private static func pngProvider(name: String) throws -> NSItemProvider {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
        try png.write(to: url)
        let provider = try #require(NSItemProvider(contentsOf: url))
        provider.suggestedName = name
        return provider
    }

    /// The page's wiring (`NotePageContent`): drops go to the composer.
    private func attach(_ f: Fixture, filler: DropUploader) -> NoteAttachmentComposer {
        let composer = NoteAttachmentComposer(noteId: f.source, filler: filler)
        f.session.attachDropped = { [session = f.session] providers, after in
            Task { await composer.attachDropped(providers, in: session, after: after) }
        }
        return composer
    }

    @Test func a_dropped_picture_is_uploaded_and_stored_after_the_block_under_the_drop() async throws {
        let f = try await fixture()
        let filler = DropUploader()
        _ = attach(f, filler: filler)

        // A picture carrying its address too, as from Safari: the text view
        // takes the drag, and hands it on.
        try await drop([try Self.pngProvider(name: "cover")], at: 2, on: f)

        let uploaded = try #require(filler.uploaded.first)
        #expect(uploaded.hasSuffix("-cover.png|image/png"), "named as Choose File names it")
        let blocks = try await blocks(f)
        #expect(blocks.map(\.kind) == ["paragraph", "image"])
        #expect(BlockText.shown(blocks[0].inline) == "see ", "the text is left as it was")
        let url = blocks.last?.props.first { $0.name == "url" }?.value
        #expect(url == AttachmentBlock.url(noteId: f.source, filename: String(uploaded.split(separator: "|")[0])))
    }

    @Test func a_dropped_pdf_the_text_view_refuses_is_stored_by_the_block() async throws {
        let f = try await fixture()
        let filler = DropUploader()
        _ = attach(f, filler: filler)
        let pdf = NSItemProvider()
        pdf.suggestedName = "report"
        pdf.registerFileRepresentation(for: .pdf, visibility: .all) { completion in
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).pdf")
            try? Data("%PDF-1.4".utf8).write(to: url)
            completion(url, false, nil)
            return nil
        }
        let session = FakeDropSession([pdf])
        let interaction = try #require(
            f.field.textView.interactions.lazy.compactMap { $0 as? UIDropInteraction }.first { $0.delegate === f.field }
        )
        #expect(f.field.dropInteraction(interaction, canHandle: session), "the text view refuses a PDF, so the block takes it")

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            f.session.reload = { done.resume() }
            f.field.dropInteraction(interaction, performDrop: session)
        }

        #expect(filler.uploaded.first?.hasSuffix("-report.pdf|application/pdf") == true)
        let blocks = try await blocks(f)
        #expect(blocks.map(\.kind) == ["paragraph", "file"])
        #expect(blocks.last?.props.first { $0.name == "mimeType" }?.value == "application/pdf")
    }

    @Test func a_refused_upload_shows_the_pickers_alert_and_adds_no_block() async throws {
        let f = try await fixture()
        let composer = NoteAttachmentComposer(noteId: f.source, filler: DropUploader(failure: SyncError.Locked))

        await composer.attachDropped([try Self.pngProvider(name: "cover")], in: f.session, after: "p1")

        guard case let .failed(error) = composer.state else {
            Issue.record("a refused drop must leave the alert's failure")
            return
        }
        #expect(error.code == ErrorMapping.locked.code)
        #expect(try await blocks(f).map(\.kind) == ["paragraph"])
    }

    private func imageURL(_ block: Block) -> String {
        block.props.first { $0.name == "url" }?.value ?? ""
    }

    @Test func dropped_files_keep_their_order_past_a_refusal_and_one_alert_counts_it() async throws {
        let f = try await fixture()
        let composer = NoteAttachmentComposer(noteId: f.source, filler: DropUploader(refusing: "B"))
        let files = try ["A", "B", "C"].map { try Self.pngProvider(name: $0) }

        await composer.attachDropped(files, in: f.session, after: "p1")

        let blocks = try await blocks(f)
        #expect(blocks.map(\.kind) == ["paragraph", "image", "image"])
        #expect(imageURL(blocks[1]).hasSuffix("-A.png") && imageURL(blocks[2]).hasSuffix("-C.png"), "in the drag's order")
        guard case let .failed(error) = composer.state else {
            Issue.record("the refusal must leave the alert's failure")
            return
        }
        #expect(error.code == ErrorMapping.locked.code, "in the refusal's words")
        #expect(error.guidance?.hasPrefix("1 of 3 files wasn't added.") == true)
    }

    @Test func an_unreadable_dropped_file_counts_as_not_added() async throws {
        let f = try await fixture()
        let composer = NoteAttachmentComposer(noteId: f.source, filler: DropUploader())
        let unreadable = NSItemProvider()
        unreadable.registerFileRepresentation(for: .pdf, visibility: .all) { completion in
            completion(nil, false, CocoaError(.fileReadNoSuchFile))
            return nil
        }

        await composer.attachDropped([unreadable, try Self.pngProvider(name: "A")], in: f.session, after: "p1")

        #expect(try await blocks(f).map(\.kind) == ["paragraph", "image"])
        guard case let .failed(error) = composer.state else {
            Issue.record("an unreadable file must not be skipped silently")
            return
        }
        #expect(error.code == ErrorMapping.droppedFileUnreadable.code)
        #expect(error.guidance?.hasPrefix("1 of 2 files wasn't added.") == true)
    }

    /// No sync session: the paperclip is hidden, and a file dragged over a
    /// block shows it will not land. A picture from Safari stays the text
    /// view's own drop.
    @Test func a_vault_without_uploads_refuses_files_visibly() async throws {
        let f = try await fixture()
        #expect(f.session.attachDropped == nil)
        let pdf = NSItemProvider()
        pdf.registerFileRepresentation(for: .pdf, visibility: .all) { _ in nil }
        let session = FakeDropSession([pdf])
        let interaction = try #require(
            f.field.textView.interactions.lazy.compactMap { $0 as? UIDropInteraction }.first { $0.delegate === f.field }
        )

        #expect(f.field.dropInteraction(interaction, canHandle: session))
        #expect(f.field.dropInteraction(interaction, sessionDidUpdate: session).operation == .forbidden)
        let picture = FakeTextDrop(at: f.field.textView.beginningOfDocument, [try Self.pngProvider(name: "cover")])
        #expect(f.field.textDroppableView(f.field.textView, proposalForDrop: picture) === picture.suggestedProposal)
    }

    @Test func text_and_links_keep_the_text_views_own_drop() throws {
        #expect(EditorDrop.of([NSItemProvider(object: "hi" as NSString)]) == nil)
        #expect(EditorDrop.of([NSItemProvider(object: URL(string: "https://example.com")! as NSURL)]) == nil)
        #expect(EditorDrop.of([try Self.pngProvider(name: "a")]) == .files)
        let zip = NSItemProvider()
        zip.registerDataRepresentation(for: .zip, visibility: .all) { $0(Data(), nil); return nil }
        #expect(EditorDrop.of([zip]) == .files, "any file, as Choose File takes any")
    }
}
