import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// A binary note's own file on the note page (#5668).
//
// | Test                                                     | Rule                         |
// | -------------------------------------------------------- | ---------------------------- |
// | opening a binary note downloads its file on any path     | on open always (#5644)       |
// | offline asks for nothing and pulls no body               | a binary note has no body    |
// | a failed download says so and only a retry asks again    | a visible failure            |

private let route = NoteRoute(id: "pdf-note")

private func cached(localPath: String?) -> CachedAttachment {
    CachedAttachment(
        attachmentId: "att-pdf",
        manifest: "{}",
        noteRefs: [],
        remoteSize: 100,
        localPath: localPath,
        downloadedAt: localPath == nil ? nil : 1,
        unmeteredOnly: true,
        pinned: false,
        filename: "scan.pdf",
        mimeType: "application/pdf"
    )
}

/// A PDF note as the core reads it: no body, its file named by id.
private final class BinaryNoteReader: NotesReading, @unchecked Sendable {
    private let landed = Mutex(false)

    func land() { landed.withLock { $0 = true } }

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        NoteDetail(
            summary: NoteSummary(
                id: id, title: "Scan", folderPath: nil,
                emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            ),
            body: NoteBody(text: "", present: false)
        )
    }

    func file(id: String) async throws -> NoteFile? {
        NoteFile(
            fileType: "pdf",
            mimeType: "application/pdf",
            attachmentId: "att-pdf",
            attachment: landed.withLock { $0 } ? cached(localPath: "att-pdf") : nil
        )
    }
}

/// Records each fetch and the path it was asked on.
private final class FileFiller: VaultFilling, @unchecked Sendable {
    private let fetches = Mutex<[Reachable]>([])
    private let bodies = Mutex(0)
    private let failing: Bool
    private let reader: BinaryNoteReader

    init(reader: BinaryNoteReader, failing: Bool = false) {
        self.reader = reader
        self.failing = failing
    }

    var fetchedOn: [Reachable] { fetches.withLock { $0 } }
    var bodyPulls: Int { bodies.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        bodies.withLock { $0 += 1 }
        return BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        fetches.withLock { $0.append(reachable) }
        if failing { throw SyncError.AttachmentCorrupt(what: "a chunk did not verify") }
        reader.land()
        return AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: "att-pdf")
    }
}

private final class FixedPath: Reachability {
    init(path: Reachable) { self.path = path }
    let path: Reachable
    func current() -> Reachable { path }
    func observe(observer: ReachabilityObserver) {}
}

@Suite("Binary note file")
@MainActor
struct NoteFileTests {
    /// A metered path defers background downloads, and opening the note is
    /// the explicit ask, so the core is asked as on an unmetered path.
    @Test("opening a binary note downloads its file on any usable path")
    func openingDownloadsOnAnyPath() async {
        let reader = BinaryNoteReader()
        let filler = FileFiller(reader: reader)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .cellular)
        )

        await model.refreshFromRemote()

        #expect(filler.fetchedOn == [.wifi])
        #expect(model.file?.attachment?.localPath == "att-pdf", "the file shows once it lands")
        #expect(filler.bodyPulls == 0, "a binary note has no body to pull")
        #expect(model.fileFetch == .idle)
    }

    @Test("offline asks for nothing and pulls no body")
    func offlineWaits() async {
        let reader = BinaryNoteReader()
        let filler = FileFiller(reader: reader)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .offline)
        )

        await model.refreshFromRemote()

        #expect(model.file?.attachmentId == "att-pdf")
        #expect(filler.fetchedOn.isEmpty)
        #expect(filler.bodyPulls == 0)
    }

    @Test("a failed download says so and only a retry asks again")
    func failureIsVisible() async {
        let reader = BinaryNoteReader()
        let filler = FileFiller(reader: reader, failing: true)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )

        await model.refreshFromRemote()
        guard case .failed = model.fileFetch else {
            Issue.record("a failed download must reach the page")
            return
        }
        await model.refreshFromRemote()
        #expect(filler.fetchedOn.count == 1, "a sync pass does not repeat a failure")

        await model.fetchFile()
        #expect(filler.fetchedOn.count == 2)
    }
}
