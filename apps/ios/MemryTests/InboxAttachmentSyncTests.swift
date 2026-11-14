import Foundation
import MemryCore
import Observation
import Synchronization
import Testing

@testable import Memry

// #4157: Inbox files travel between devices. The redriver the shell already
// runs after each pass also syncs them, filing reuses the blob the capture
// uploaded, and a row shows a picture it only holds as the original.

/// Scripts the Inbox file calls and records what the shell asked for.
private final class InboxFilesFiller: VaultFilling, @unchecked Sendable {
    private let state = Mutex(State())

    struct State {
        var summaries: [InboxAttachmentSyncSummary] = []
        var inboxSyncs: [Reachable] = []
        var passes = 0
        var noteRedrives = 0
        var noteRedriveFails = false
        var inboxSyncFails = false
        var attachCalls: [String] = []
        var uploadCalls = 0
        var attached = InboxFileAttachment(attachmentId: "att-1", filename: "manifest-name.png")
    }

    init(summaries: [InboxAttachmentSyncSummary] = []) {
        state.withLock { $0.summaries = summaries }
    }

    var inboxSyncs: [Reachable] { state.withLock { $0.inboxSyncs } }
    var passes: Int { state.withLock { $0.passes } }
    var noteRedrives: Int { state.withLock { $0.noteRedrives } }
    var attachCalls: [String] { state.withLock { $0.attachCalls } }
    var uploadCalls: Int { state.withLock { $0.uploadCalls } }
    func failNoteRedrive() { state.withLock { $0.noteRedriveFails = true } }
    func failInboxSync() { state.withLock { $0.inboxSyncFails = true } }
    func attach(returning attached: InboxFileAttachment) { state.withLock { $0.attached = attached } }

    static func summary(uploaded: UInt32 = 0, downloaded: UInt32 = 0) -> InboxAttachmentSyncSummary {
        InboxAttachmentSyncSummary(uploaded: uploaded, downloaded: downloaded, deferred: 0, failed: 0, released: 0)
    }

    func syncInboxAttachments(reachable: Reachable) async throws -> InboxAttachmentSyncSummary {
        try state.withLock { state in
            state.inboxSyncs.append(reachable)
            if state.inboxSyncFails { throw SyncError.Locked }
            return state.summaries.isEmpty ? Self.summary() : state.summaries.removeFirst()
        }
    }

    func redriveAttachments(reachable: Reachable) async throws -> AttachmentRedriveSummary {
        try state.withLock { state in
            state.noteRedrives += 1
            if state.noteRedriveFails { throw SyncError.Locked }
            return AttachmentRedriveSummary(downloaded: 0, deferred: 0, failed: 0, remaining: 0)
        }
    }

    func syncNow() async throws -> SyncPassSummary {
        state.withLock { $0.passes += 1 }
        return SyncPassSummary(pulled: 0, deleted: 0, bodies: 0, pushed: 0, rejected: 0, pending: 0)
    }

    func attachInboxFile(
        itemId: String,
        noteId: String,
        filename: String,
        mimeType: String
    ) async throws -> InboxFileAttachment {
        state.withLock { state in
            state.attachCalls.append("\(itemId)|\(noteId)|\(mimeType)")
            return state.attached
        }
    }

    func uploadAttachment(
        noteId: String,
        filename: String,
        mimeType: String,
        bytes: Data
    ) async throws -> String {
        state.withLock { $0.uploadCalls += 1 }
        return "att-fresh"
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}

@MainActor
@Suite("Inbox file redrive", .serialized)
struct InboxFileRedriveTests {
    private func redriver(
        _ filler: InboxFilesFiller,
        reachable: Reachable = .wifi,
        center: NotificationCenter = NotificationCenter()
    ) -> AttachmentRedriver {
        AttachmentRedriver(filler: filler, reachability: { reachable }, center: center)
    }

    @Test func the_redrive_syncs_inbox_files_with_the_current_path() async {
        let filler = InboxFilesFiller()
        await redriver(filler, reachable: .cellular).redrive()
        #expect(filler.inboxSyncs == [.cellular])
    }

    @Test func offline_syncs_no_inbox_files() async {
        let filler = InboxFilesFiller()
        await redriver(filler, reachable: .offline).redrive()
        #expect(filler.inboxSyncs.isEmpty)
    }

    @Test func an_upload_asks_for_one_more_pass_and_nothing_else_does() async {
        var requests = 0
        for summary in [
            InboxFilesFiller.summary(),
            InboxFilesFiller.summary(downloaded: 3),
            InboxFilesFiller.summary(uploaded: 2)
        ] {
            let filler = InboxFilesFiller(summaries: [summary])
            let subject = redriver(filler)
            let before = requests
            subject.requestSync = { requests += 1 }
            await subject.redrive()
            #expect(requests == before + (summary.uploaded > 0 ? 1 : 0))
        }
        #expect(requests == 1)
    }

    @Test func a_download_tells_the_inbox_and_a_quiet_redrive_does_not() async {
        let center = NotificationCenter()
        var heard = 0
        let token = center.addObserver(forName: AttachmentRedriver.inboxFilesDownloaded, object: nil, queue: nil) { _ in
            heard += 1
        }
        defer { center.removeObserver(token) }

        await redriver(InboxFilesFiller(summaries: [InboxFilesFiller.summary(uploaded: 1)]), center: center).redrive()
        #expect(heard == 0)
        await redriver(InboxFilesFiller(summaries: [InboxFilesFiller.summary(downloaded: 2)]), center: center).redrive()
        #expect(heard == 1)
    }

    @Test func neither_half_skips_the_other_when_it_fails() async {
        let failingNotes = InboxFilesFiller()
        failingNotes.failNoteRedrive()
        await redriver(failingNotes).redrive()
        #expect(failingNotes.noteRedrives == 1)
        #expect(failingNotes.inboxSyncs.count == 1)

        let failingInbox = InboxFilesFiller()
        failingInbox.failInboxSync()
        await redriver(failingInbox).redrive()
        #expect(failingInbox.noteRedrives == 1)
        #expect(failingInbox.inboxSyncs.count == 1)
    }

    /// Through the tasks store the app uses: an upload sets the capture's
    /// `attachmentId` locally, so a second pass must carry it out, and that
    /// pass uploads nothing, so the chain stops there.
    @Test func an_upload_in_a_sync_pass_gets_exactly_one_more_pass() async throws {
        let filler = InboxFilesFiller(summaries: [InboxFilesFiller.summary(uploaded: 1)])
        let tasks = try TasksTestVault(filler: filler)
        await tasks.store.sync()
        try await wait { filler.passes >= 2 }
        #expect(filler.passes == 2)
        try await Task.sleep(for: .milliseconds(1200))
        #expect(filler.passes == 2, "the extra pass asked for another")
    }
}

@MainActor
@Suite("Inbox filing reuses the synced file", .serialized)
struct InboxFilingAttachmentTests {
    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ) ?? Data()

    private func fileStore(
        _ scratch: InboxTestVault,
        filler: InboxFilesFiller
    ) throws -> (store: InboxStore, notes: any NotesProtocol, writer: any NotesWriterProtocol) {
        let notes = scratch.vault.notes()
        let writer = try scratch.vault.notesWriter(store: TaskTestKeychain())
        let store = InboxStore(
            core: scratch.inbox, vaultId: "vault-inbox-test", vaultDirectory: scratch.directory,
            filler: filler, notes: notes, writer: writer, transcription: .scripted
        )
        return (store, notes, writer)
    }

    private func capturePhoto(_ store: InboxStore) async throws -> InboxItemRecord {
        let result = await store.captureFile(data: Self.onePixelPNG, filename: "[agent] photo.png", mimeType: "image/png")
        guard case .captured = result, let item = store.items.first else {
            throw CaptureFailed()
        }
        return item
    }

    private struct CaptureFailed: Error {}

    @Test func a_filed_capture_embeds_under_the_filename_the_core_returned() async throws {
        let filler = InboxFilesFiller()
        filler.attach(returning: InboxFileAttachment(attachmentId: "att-9", filename: "manifest-name.png"))
        let scratch = try InboxTestVault()
        let (store, notes, _) = try fileStore(scratch, filler: filler)
        let item = try await capturePhoto(store)

        await store.file(item, to: "Agent Test", tags: [])

        let noteId = try #require(try notes.list().first?.id)
        #expect(filler.attachCalls == ["\(item.id)|\(noteId)|image/png"])
        #expect(filler.uploadCalls == 0, "filing uploaded the file a second time")
        let blocks = try #require(try notes.blocks(id: noteId))
        let image = try #require(blocks.first { $0.kind == "image" })
        #expect(image.props.first { $0.name == "url" }?.value == "attachments/\(noteId)/manifest-name.png")
        #expect(image.props.first { $0.name == "name" }?.value == "manifest-name.png")
        #expect(store.items.isEmpty)
    }

    @Test func a_linked_capture_records_the_returned_filename_as_where_it_went() async throws {
        let filler = InboxFilesFiller()
        filler.attach(returning: InboxFileAttachment(attachmentId: "att-9", filename: "manifest-name.png"))
        let scratch = try InboxTestVault()
        let (store, _, writer) = try fileStore(scratch, filler: filler)
        let item = try await capturePhoto(store)
        let noteId = try writer.create(title: "[agent] target", folderPath: nil)

        await store.link(
            item, to: [InboxLinkChoice(noteId: noteId, title: "[agent] target")],
            folder: "", tags: [], imageMode: .embed
        )

        #expect(try scratch.inbox.get(id: item.id)?.filedTo == "attachments/\(noteId)/manifest-name.png")
        #expect(filler.uploadCalls == 0)
    }
}

@MainActor
@Suite("Inbox pictures", .serialized)
struct InboxPictureFallbackTests {
    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    ) ?? Data()

    private func captured() async throws -> (InboxTestVault, InboxItemRecord) {
        let scratch = try InboxTestVault()
        _ = await scratch.store.captureFile(data: Self.onePixelPNG, filename: "[agent] photo.png", mimeType: "image/png")
        let item = try #require(scratch.store.items.first)
        return (scratch, item)
    }

    @Test func a_missing_thumbnail_falls_back_to_the_synced_original() async throws {
        let (scratch, item) = try await captured()
        var synced = item
        synced.thumbnailPath = "attachments/inbox/\(item.id)/not-synced-thumbnail.jpg"
        let original = try #require(scratch.store.localFile(item.attachmentPath))
        #expect(scratch.store.localFile(synced.thumbnailPath) == nil)
        #expect(scratch.store.thumbnailFile(for: synced) == original)
    }

    @Test func a_present_thumbnail_wins() async throws {
        let (scratch, item) = try await captured()
        let thumbnail = try #require(scratch.store.localFile(item.thumbnailPath))
        #expect(scratch.store.thumbnailFile(for: item) == thumbnail)
    }

    @Test func a_download_makes_a_view_that_read_a_missing_file_read_it_again() async throws {
        let scratch = try InboxTestVault()
        let path = "attachments/inbox/[agent]-late/photo.png"
        #expect(scratch.store.localFile(path) == nil)
        let changed = Mutex(false)
        withObservationTracking {
            _ = scratch.store.localFile(path)
        } onChange: {
            changed.withLock { $0 = true }
        }
        scratch.store.inboxFilesDownloaded()
        #expect(changed.withLock { $0 })
    }
}
