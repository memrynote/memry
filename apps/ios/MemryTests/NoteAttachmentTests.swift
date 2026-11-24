import Foundation
import MemryCore
import SwiftUI
import Synchronization
import Testing
import UIKit

@testable import Memry

// Attachments on the note screen (N206, N207, FR-045).
//
// | Test                                                    | Rule                    |
// | ------------------------------------------------------- | ----------------------- |
// | a bound attachment with no bytes yet is still waiting   | placeholder, not a gap  |
// | bytes that land re-resolve in place                     | FR-045's "without the note being recreated" |
// | a metered refusal is not an error and keeps the placeholder | FR-045's default    |
// | opening a note names a peer's picture, then fetches it  | #5675                   |
// | offline, opening names nothing                          | #5675                   |
// | a remote url is ordinary content, not a failed download | §Q4                     |
// | an ambiguous basename is refused, never guessed         | §Q4                     |
// | only attachment-bearing blocks are resolved             | a bookmark url is not a vault path |
// | a cancelled fetch asks for no further picture           | REVIEW-5587: no repeat download per pass |
// | the page asks for pictures before the body pull answers | REVIEW-5587: no network wait on open |

// MARK: - fakes

/// A reader whose attachment answers a test scripts.
private final class ScriptedAttachments: NotesReading, @unchecked Sendable {
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
        resolved.withLock { $0.append(url) }
        return bindings.withLock { $0[url] } ?? .unknown
    }
}

/// A filler that reports what the core would for one attachment.
private final class ScriptedAttachmentFiller: VaultFilling, @unchecked Sendable {
    private let summary: AttachmentFetchSummary
    private let calls = Mutex<[String]>([])
    private let manifestCalls = Mutex<[String]>([])
    private let onFetch: (@Sendable () -> Void)?
    private let onManifests: (@Sendable () -> UInt32)?

    init(
        summary: AttachmentFetchSummary,
        onFetch: (@Sendable () -> Void)? = nil,
        onManifests: (@Sendable () -> UInt32)? = nil
    ) {
        self.summary = summary
        self.onFetch = onFetch
        self.onManifests = onManifests
    }

    var fetched: [String] { calls.withLock { $0 } }
    /// Every note whose manifests the model asked for, in order.
    var named: [String] { manifestCalls.withLock { $0 } }

    func fetchNoteManifests(noteId: String) async throws -> UInt32 {
        manifestCalls.withLock { $0.append(noteId) }
        return onManifests?() ?? 0
    }

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
        onFetch?()
        return summary
    }
}

/// Holds each attachment fetch and body pull until `release()`, as a core
/// call runs to its end whether or not its task was cancelled.
private final class GatedFiller: VaultFilling, @unchecked Sendable {
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

private final class FixedPath: Reachability {
    init(path: Reachable) { self.path = path }
    let path: Reachable
    func current() -> Reachable { path }
    func observe(observer: ReachabilityObserver) {}
}

// MARK: - helpers

private func imageBlock(url: String) -> Block {
    Block(
        id: "b1",
        kind: "image",
        depth: 0,
        props: [BlockProp(name: "url", value: url)],
        inline: []
    )
}

private func cached(id: String, localPath: String?) -> CachedAttachment {
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

private let route = NoteRoute(id: "note-1")

@Suite("Note attachments")
@MainActor
struct NoteAttachmentTests {
    /// A reference this device knows about whose bytes have not arrived is
    /// **waiting**, not missing. FR-045 requires a placeholder rather than a
    /// gap in the middle of a note.
    @Test("a bound attachment with no bytes yet resolves to a placeholder")
    func boundWithoutBytesIsWaiting() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let model = NoteReadViewModel(route: route, reader: reader)
        await model.loadIfNeeded()

        let binding = NoteAttachmentBinding.of("picture.png") {
            model.attachments[$0] ?? .unknown
        }
        // `.waitingFor` rather than `.waiting`: the reference is known even
        // though the bytes are not here, which is what lets the user remove a
        // picture they added by mistake before it finishes downloading.
        #expect(
            binding == .waitingFor("att-1"),
            "bytes that have not arrived are not a broken block"
        )
    }

    /// FR-045 in as many words: the picture "becomes visible on arrival
    /// **without the note being recreated**". The model re-resolves into the
    /// same dictionary, so the existing views re-render and the reader keeps
    /// their scroll position.
    @Test("bytes that land become visible without the note being reloaded")
    func lateArrivalBecomesVisibleInPlace() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        // The download lands: the core's row now carries a path, so the next
        // resolve binds to a file.
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(
                downloaded: true, deferred: false, bytes: 100, localPath: "att-1"
            ),
            onFetch: { reader.rebind("picture.png", to: .bound(attachment: cached(id: "att-1", localPath: "att-1"))) }
        )

        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.loadIfNeeded()
        #expect(NoteAttachmentBinding.of("picture.png") { model.attachments[$0] ?? .unknown }
            == .waitingFor("att-1"))

        await model.fetchWaitingAttachments()

        #expect(filler.fetched == ["att-1"])
        guard case let .bound(attachment) = model.attachments["picture.png"] else {
            Issue.record("the attachment did not rebind after its bytes landed")
            return
        }
        #expect(attachment.localPath == "att-1")
    }

    /// REVIEW-5587: each sync pass restarts the page's task. The cancelled
    /// loop stops after the fetch in flight; the next task asks again.
    @Test("a cancelled fetch of waiting pictures asks for no further one", .timeLimit(.minutes(1)))
    func aCancelledFetchStops() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "a.png"), imageBlock(url: "b.png")],
            bindings: [
                "a.png": .bound(attachment: cached(id: "att-a", localPath: nil)),
                "b.png": .bound(attachment: cached(id: "att-b", localPath: nil)),
            ]
        )
        let filler = GatedFiller()
        let model = NoteReadViewModel(route: route, reader: reader, filler: filler, reachability: FixedPath(path: .wifi))
        await model.loadIfNeeded()

        let run = Task { await model.fetchWaitingAttachments() }
        for await _ in filler.started { break }
        run.cancel()
        filler.release()
        await run.value
        #expect(filler.fetched.count == 1)
    }

    /// REVIEW-5587: opening a note asks for its pictures right after the
    /// local read, not after the body pull's round trip.
    @Test("the page asks for its pictures while the body pull is out", .timeLimit(.minutes(1)))
    func picturesDoNotWaitForThePull() async throws {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = GatedFiller()
        defer { filler.release() }
        // Its own id: parallel suites announce edits to shared ids.
        let model = NoteReadViewModel(
            route: NoteRoute(id: UUID().uuidString), reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        let window = UIWindow(windowScene: try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene))
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        window.rootViewController = UIHostingController(
            rootView: Color.clear.modifier(NotePageLoad(model: model, source: UUID()))
        )

        for await _ in filler.started { break }
        #expect(filler.fetched == ["att-1"])
    }

    /// A picture waiting for an unmetered path is the feature working. The
    /// placeholder stays and nothing is reported as a failure.
    @Test("a deferred fetch is not an error and leaves the placeholder")
    func deferredIsNotAFailure() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(
                downloaded: false, deferred: true, bytes: 0, localPath: nil
            )
        )
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .cellular)
        )
        await model.loadIfNeeded()
        await model.fetchWaitingAttachments()

        #expect(filler.fetched == ["att-1"], "the core is still asked; it owns the policy")
        #expect(
            NoteAttachmentBinding.of("picture.png") { model.attachments[$0] ?? .unknown }
                == .waitingFor("att-1"),
            "a deferred picture keeps its placeholder"
        )
    }

    /// #5675: a peer's picture reaches this device as a reference with no
    /// filename, so its block binds to nothing until the manifest is read.
    /// Opening the note reads it, the block binds, and its bytes are fetched.
    @Test("opening a note names a peer's picture, then fetches it")
    func unnamedPictureIsNamedThenFetched() async {
        let reader = ScriptedAttachments(blocks: [imageBlock(url: "picture.png")], bindings: [:])
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(
                downloaded: true, deferred: false, bytes: 100, localPath: "att-1"
            ),
            onFetch: { reader.rebind("picture.png", to: .bound(attachment: cached(id: "att-1", localPath: "att-1"))) },
            onManifests: {
                reader.rebind("picture.png", to: .bound(attachment: cached(id: "att-1", localPath: nil)))
                return 1
            }
        )
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.loadIfNeeded()
        #expect(model.attachments["picture.png"] == .unknown, "no name yet")

        await model.fetchWaitingAttachments()

        #expect(filler.named == ["note-1"])
        #expect(filler.fetched == ["att-1"], "the newly bound picture is fetched in the same open")
        guard case let .bound(attachment) = model.attachments["picture.png"] else {
            Issue.record("the picture did not bind after its manifest was read")
            return
        }
        #expect(attachment.localPath == "att-1")
    }

    @Test("offline, opening a note names nothing")
    func offlineNamesNothing() async {
        let reader = ScriptedAttachments(blocks: [imageBlock(url: "picture.png")], bindings: [:])
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(downloaded: false, deferred: true, bytes: 0, localPath: nil),
            onManifests: { 1 }
        )
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .offline)
        )
        await model.loadIfNeeded()
        await model.fetchWaitingAttachments()

        #expect(filler.named.isEmpty)
        #expect(model.attachments["picture.png"] == .unknown)
    }

    /// Q4: desktop refuses to resolve a scheme-bearing url against the vault
    /// and calls a remote image "ordinary content, not a defect".
    @Test("a remote url is ordinary content rather than a failed download")
    func remoteIsNotAFailure() {
        let binding = NoteAttachmentBinding.of("https://example.com/a.png") { _ in
            .remote(url: "https://example.com/a.png")
        }
        #expect(binding == .remote("https://example.com/a.png"))
    }

    /// Q4: one note holding two attachments with the same basename. Desktop
    /// cannot tell them apart either, so picking one risks showing the wrong
    /// picture — worse than showing none.
    @Test("an ambiguous basename is refused rather than guessed")
    func ambiguousIsRefused() {
        let binding = NoteAttachmentBinding.of("shot.png") { _ in
            .ambiguous(basename: "shot.png")
        }
        #expect(binding == .ambiguous)
    }

    /// A bookmark's url is a web address, not a vault path, and asking the
    /// core about it would ask it to resolve something it correctly refuses.
    @Test("only attachment-bearing blocks are resolved")
    func onlyAttachmentBlocksAreResolved() {
        let blocks = [
            imageBlock(url: "picture.png"),
            Block(
                id: "b2", kind: "bookmark", depth: 0,
                props: [BlockProp(name: "url", value: "https://example.com")], inline: []
            ),
            Block(
                id: "b3", kind: "paragraph", depth: 0,
                props: [BlockProp(name: "url", value: "nonsense")], inline: []
            ),
            Block(
                id: "b4", kind: "file", depth: 0,
                props: [BlockProp(name: "url", value: "spec.pdf")], inline: []
            )
        ]
        #expect(NoteReadViewModel.attachmentUrls(in: blocks) == ["picture.png", "spec.pdf"])
    }

    /// A picture the user added by mistake must be removable before it has
    /// finished downloading: the id is known even when the bytes are not here.
    @Test("a waiting attachment can still be removed")
    func waitingAttachmentsCarryTheirId() {
        let waiting = NoteAttachmentBinding.of("picture.png") { _ in
            .bound(attachment: cached(id: "att-1", localPath: nil))
        }
        #expect(waiting == .waitingFor("att-1"))
        #expect(waiting.attachmentId == "att-1")

        let landed = NoteAttachmentBinding.of("picture.png") { _ in
            .bound(attachment: cached(id: "att-1", localPath: "att-1"))
        }
        #expect(landed.attachmentId == "att-1")
    }

    /// Neither resolves to a single attachment, so neither can be released \u2014
    /// and offering the action would be offering a failure.
    @Test("a remote or ambiguous binding offers no removal")
    func unremovableBindingsCarryNoId() {
        #expect(NoteAttachmentBinding.remote("https://example.com/a.png").attachmentId == nil)
        #expect(NoteAttachmentBinding.ambiguous.attachmentId == nil)
        #expect(NoteAttachmentBinding.waiting.attachmentId == nil)
    }

    /// The same url twice is one question, not two.
    @Test("a repeated url is resolved once")
    func repeatedUrlsAreDeduplicated() {
        let blocks = [imageBlock(url: "a.png"), imageBlock(url: "a.png")]
        #expect(NoteReadViewModel.attachmentUrls(in: blocks) == ["a.png"])
    }
}

// Every vault open writes `AttachmentPaths.imagesDirectory`, and parallel
// suites open vaults at once. An unsynchronized `URL?` write releases the old
// value twice under that race and crashes the test host with SIGSEGV (#2677).
@Suite("attachment paths")
struct AttachmentPathsTests {
    @Test("concurrent writes and reads of the images directory do not race")
    func concurrentWritesAndReadsAreSafe() async {
        // Each write is a fresh copy of the value just read: the race needs new
        // objects to release, and copying keeps this test from moving the
        // directory under a parallel suite that opens a vault and reads it.
        await withTaskGroup(of: Void.self) { group in
            for _ in 0 ..< 8 {
                group.addTask {
                    for _ in 0 ..< 20000 {
                        // Unset reads as the temporary directory, so writing that is no change.
                        let current = AttachmentPaths.imagesDirectory ?? URL.temporaryDirectory
                        AttachmentPaths.imagesDirectory = URL(fileURLWithPath: current.path, isDirectory: true)
                    }
                }
            }
        }
    }
}
