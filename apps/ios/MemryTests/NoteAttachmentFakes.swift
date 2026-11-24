import Foundation
import MemryCore
import Synchronization

@testable import Memry

// The note page's attachment fakes, shared by `NoteAttachmentTests`.

// MARK: - fakes

/// A reader whose attachment answers a test scripts.
final class ScriptedAttachments: NotesReading, @unchecked Sendable {
    private let blocks: [Block]
    private let bindings: Mutex<[String: BlockAttachment]>
    private let resolved = Mutex<[String]>([])

    init(blocks: [Block], bindings: [String: BlockAttachment]) {
        self.blocks = blocks
        self.bindings = Mutex(bindings)
    }

    /// Every url the model asked about, in order.
    var asked: [String] { resolved.withLock { $0 } }

    func rebind(_ url: String, to binding: BlockAttachment) {
        bindings.withLock { $0[url] = binding }
    }

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        NoteDetail(
            summary: NoteSummary(
                id: id, title: "a note", folderPath: nil,
                emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            ),
            body: NoteBody(text: "body", present: true)
        )
    }

    func blocks(id: String) async throws -> [Block]? { blocks }

    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        // As the live reader's `CoreExecutor.run` does.
        try Task.checkCancellation()
        resolved.withLock { $0.append(url) }
        return bindings.withLock { $0[url] } ?? .unknown
    }
}

/// A filler that reports what the core would for one attachment.
final class ScriptedAttachmentFiller: VaultFilling, @unchecked Sendable {
    private let summary: AttachmentFetchSummary
    private let calls = Mutex<[String]>([])
    private let paths = Mutex<[Reachable]>([])
    private let onFetch: (@Sendable () -> Void)?
    private let failure: SyncError?

    init(summary: AttachmentFetchSummary, failure: SyncError? = nil, onFetch: (@Sendable () -> Void)? = nil) {
        self.summary = summary
        self.failure = failure
        self.onFetch = onFetch
    }

    var fetched: [String] { calls.withLock { $0 } }
    /// The path each fetch was judged against.
    var judged: [Reachable] { paths.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        calls.withLock { $0.append(attachmentId) }
        paths.withLock { $0.append(reachable) }
        if let failure { throw failure }
        onFetch?()
        return summary
    }
}

/// A filler whose first fetch waits until the test lets it finish, and whose
/// later fetches land at once: two runs downloading side by side.
final class FirstFetchGatedFiller: VaultFilling, @unchecked Sendable {
    private let calls = Mutex<[String]>([])
    private let (entered, enter) = AsyncStream<Void>.makeStream()
    private let (gate, open) = AsyncStream<Void>.makeStream()
    private let onLanded: @Sendable (String) -> Void

    init(onLanded: @escaping @Sendable (String) -> Void) {
        self.onLanded = onLanded
    }

    var fetched: [String] { calls.withLock { $0 } }

    func waitUntilFetching() async {
        for await _ in entered { return }
    }

    func finish() { open.yield() }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        let first = calls.withLock { calls in
            calls.append(attachmentId)
            return calls.count == 1
        }
        if first {
            enter.yield()
            let gate = gate
            await Task { for await _ in gate { break } }.value
        }
        onLanded(attachmentId)
        return AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: attachmentId)
    }
}

/// A filler whose one fetch waits until the test lets it finish, so the test
/// can see the screen while the download runs. It lands the bytes when it has
/// no `failure`, and ignores cancellation as a UniFFI async call does.
final class GatedAttachmentFiller: VaultFilling, @unchecked Sendable {
    private let calls = Mutex(0)
    private let (entered, enter) = AsyncStream<Void>.makeStream()
    private let (gate, open) = AsyncStream<Void>.makeStream()
    private let failure: SyncError?
    private let onLanded: (@Sendable () -> Void)?

    init(failure: SyncError?, onLanded: (@Sendable () -> Void)? = nil) {
        self.failure = failure
        self.onLanded = onLanded
    }

    var fetches: Int { calls.withLock { $0 } }

    func waitUntilFetching() async {
        for await _ in entered { return }
    }

    func finish() { open.yield() }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        calls.withLock { $0 += 1 }
        enter.yield()
        let gate = gate
        await Task { for await _ in gate { break } }.value
        if let failure { throw failure }
        onLanded?()
        return AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: attachmentId)
    }
}

final class FixedPath: Reachability {
    init(path: Reachable) { self.path = path }
    let path: Reachable
    func current() -> Reachable { path }
    func observe(observer: ReachabilityObserver) {}
}

// MARK: - helpers

func imageBlock(url: String) -> Block {
    Block(
        id: "b1",
        kind: "image",
        depth: 0,
        props: [BlockProp(name: "url", value: url)],
        inline: []
    )
}

func cached(id: String, localPath: String?) -> CachedAttachment {
    CachedAttachment(
        attachmentId: id,
        manifest: "{}",
        noteRefs: ["note-1"],
        remoteSize: 100,
        localPath: localPath,
        downloadedAt: localPath == nil ? nil : 1,
        unmeteredOnly: true,
        pinned: false,
        filename: "picture.png",
        mimeType: "image/png"
    )
}

/// Holds each attachment fetch and body pull until `release()`, as a core
/// call runs to its end whether or not its task was cancelled.
final class HeldAttachmentFiller: VaultFilling, @unchecked Sendable {
    let started: AsyncStream<Void>
    private let start: AsyncStream<Void>.Continuation
    private let calls = Mutex<[String]>([])
    private let gate = Mutex<(open: Bool, held: [CheckedContinuation<Void, Never>])>((false, []))

    init() { (started, start) = AsyncStream.makeStream() }

    var fetched: [String] { calls.withLock { $0 } }

    /// Lets every held call through, and every later one.
    func release() {
        let held = gate.withLock { state in
            state.open = true
            defer { state.held = [] }
            return state.held
        }
        held.forEach { $0.resume() }
    }

    private func pass() async {
        await withCheckedContinuation { continuation in
            let open = gate.withLock { state in
                if !state.open { state.held.append(continuation) }
                return state.open
            }
            if open { continuation.resume() }
        }
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        await pass()
        return BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        calls.withLock { $0.append(attachmentId) }
        start.yield()
        await pass()
        return AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: attachmentId)
    }
}
