import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// Attachments on the note screen (N206, N207, FR-045).
//
// | Test                                                    | Rule                    |
// | ------------------------------------------------------- | ----------------------- |
// | a bound attachment with no bytes yet is still waiting   | placeholder, not a gap  |
// | bytes that land re-resolve in place                     | FR-045's "without the note being recreated" |
// | a metered refusal is not an error and keeps the placeholder | FR-045's default    |
// | a remote url is ordinary content, not a failed download | §Q4                     |
// | an ambiguous basename is refused, never guessed         | §Q4                     |
// | only attachment-bearing blocks are resolved             | a bookmark url is not a vault path |

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
                emoji: nil, createdAt: nil, modifiedAt: nil
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
    private let onFetch: (@Sendable () -> Void)?

    init(summary: AttachmentFetchSummary, onFetch: (@Sendable () -> Void)? = nil) {
        self.summary = summary
        self.onFetch = onFetch
    }

    var fetched: [String] { calls.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
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
