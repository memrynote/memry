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
// | a file the row names but the disk lacks is fetched again | a missing file is not shown  |
// | a whole file is intact, a missing or torn one is not     | the manifest's size          |
// | a tap under a file note starts no paragraph              | a file note has no body      |
// | a peer's replacement while open is fetched in that pass  | a new id is a new file       |

private let route = NoteRoute(id: "pdf-note")

private func cached(id: String = "att-pdf", localPath: String?, manifest: String = "{}") -> CachedAttachment {
    CachedAttachment(
        attachmentId: id,
        manifest: manifest,
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
    private let landed: Mutex<Bool>
    private let id = Mutex("att-pdf")

    /// `landed`: the row already names a local file, which the disk need not hold.
    init(landed: Bool = false) { self.landed = Mutex(landed) }

    func land() { landed.withLock { $0 = true } }

    /// A peer uploaded a new file for the note: a new attachment id (#5626).
    func replace(with newId: String) {
        id.withLock { $0 = newId }
        landed.withLock { $0 = false }
    }

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

    func file(id _: String) async throws -> NoteFile? {
        let id = id.withLock { $0 }
        return NoteFile(
            fileType: "pdf",
            mimeType: "application/pdf",
            attachmentId: id,
            attachment: landed.withLock { $0 } ? cached(id: id, localPath: id) : nil
        )
    }
}

/// Records each fetch and the path it was asked on.
private final class FileFiller: VaultFilling, @unchecked Sendable {
    private let fetches = Mutex<[Reachable]>([])
    private let ids = Mutex<[String]>([])
    private let bodies = Mutex(0)
    private let failing: Bool
    private let reader: BinaryNoteReader

    init(reader: BinaryNoteReader, failing: Bool = false) {
        self.reader = reader
        self.failing = failing
    }

    var fetchedOn: [Reachable] { fetches.withLock { $0 } }
    var fetchedIds: [String] { ids.withLock { $0 } }
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
        ids.withLock { $0.append(attachmentId) }
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

    /// VERIFY-5674: a row can name a file the disk lost or holds half of.
    /// Drawing it shows a broken file; asking the core downloads it over.
    @Test("a file the row names but the disk lacks is fetched again")
    func missingFileIsFetchedAgain() async {
        let reader = BinaryNoteReader(landed: true)
        let filler = FileFiller(reader: reader)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )

        await model.refreshFromRemote()

        #expect(filler.fetchedIds == ["att-pdf"])
    }

    @Test("a whole file is intact, a missing or torn one is not")
    func intactPathHoldsTheFileToItsManifest() throws {
        let images = URL.temporaryDirectory.appending(path: "intact-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: images) }
        let under = { (path: String) in images.appending(path: path) }
        let manifest = #"{"id":"att-pdf","size":5}"#

        let row = cached(localPath: "att-pdf", manifest: manifest)
        #expect(row.intactPath(under: under) == nil, "missing")
        try Data("%PDF".utf8).write(to: under("att-pdf"))
        #expect(row.intactPath(under: under) == nil, "torn")
        try Data("%PDF!".utf8).write(to: under("att-pdf"))
        #expect(row.intactPath(under: under) == "att-pdf", "whole")
        #expect(cached(localPath: "att-pdf").intactPath(under: under) == "att-pdf", "no size to check")
        #expect(cached(localPath: nil, manifest: manifest).intactPath(under: under) == nil)
    }

    /// REVIEW-5688: Return in the title is blocked on a file note, and a tap
    /// under its file is the other way into a body it does not have.
    @Test("a tap under a file note starts no paragraph")
    func tapUnderFileStartsNoParagraph() async {
        let reader = BinaryNoteReader()
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: FileFiller(reader: reader),
            reachability: FixedPath(path: .offline)
        )

        await model.refreshFromRemote()

        #expect(model.file != nil)
        #expect(!model.tapStartsParagraph(canEdit: true))
    }

    @Test("a peer's replacement while open is fetched in that pass")
    func replacementWhileOpenIsFetched() async {
        let reader = BinaryNoteReader()
        let filler = FileFiller(reader: reader)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.refreshFromRemote()
        #expect(filler.fetchedIds.last == "att-pdf")

        reader.replace(with: "att-new")
        await model.refreshFromRemote()

        #expect(model.file?.attachmentId == "att-new")
        #expect(filler.fetchedIds.last == "att-new", "the new file is not left for the next pass")
    }
}
