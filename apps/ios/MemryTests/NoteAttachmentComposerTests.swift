import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// Adding and removing a note's attachments (N214, N215).
//
// | Test                                              | Rule                        |
// | ------------------------------------------------- | --------------------------- |
// | an upload hands back the id it created            | the caller re-resolves with it |
// | a failure maps through ErrorMapping               | never a raw Rust string     |
// | no session means no affordance                    | a button that leads nowhere is worse than none |
// | a mime type comes from the platform, not a guess  | unknown is `application/octet-stream` |
// | a capture name sorts by when it was taken         | the filename is the binding (§Q4) |

private final class ScriptedUploader: VaultFilling, @unchecked Sendable {
    private let result: Result<String, any Error>
    private let uploads = Mutex<[String]>([])
    private let detaches = Mutex<[String]>([])
    private let detachFailure: (any Error)?

    init(result: Result<String, any Error>, detachFailure: (any Error)? = nil) {
        self.result = result
        self.detachFailure = detachFailure
    }

    var uploaded: [String] { uploads.withLock { $0 } }
    var detached: [String] { detaches.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }

    func uploadAttachment(
        noteId: String,
        filename: String,
        mimeType: String,
        bytes: Data
    ) async throws -> String {
        uploads.withLock { $0.append("\(filename)|\(mimeType)|\(bytes.count)") }
        return try result.get()
    }

    func detachAttachment(noteId: String, attachmentId: String) async throws {
        detaches.withLock { $0.append(attachmentId) }
        if let detachFailure { throw detachFailure }
    }
}

@Suite("Note attachment composer")
@MainActor
struct NoteAttachmentComposerTests {
    @Test("an upload hands back the id, so the note can re-resolve in place")
    func uploadReturnsTheId() async {
        let filler = ScriptedUploader(result: .success("att-new"))
        let composer = NoteAttachmentComposer(noteId: "note-1", filler: filler)

        let id = await composer.upload(
            filename: "a.png",
            mimeType: "image/png",
            bytes: Data([1, 2, 3])
        )

        #expect(id == "att-new")
        #expect(filler.uploaded == ["a.png|image/png|3"])
        #expect(composer.state == .idle)
        #expect(!composer.isBusy)
    }

    /// A raw Rust error string must never reach an alert.
    @Test("a failed upload carries mapped copy, not a raw error")
    func failureIsMapped() async {
        let filler = ScriptedUploader(result: .failure(SyncError.Locked))
        let composer = NoteAttachmentComposer(noteId: "note-1", filler: filler)

        let id = await composer.upload(filename: "a.png", mimeType: "image/png", bytes: Data())

        #expect(id == nil)
        guard case let .failed(error) = composer.state else {
            Issue.record("a failed upload must leave a failure state")
            return
        }
        #expect(error.code == ErrorMapping.locked.code)
        #expect(error.code != ErrorMapping.unrecognised.code)

        composer.dismissFailure()
        #expect(composer.state == .idle)
    }

    /// An affordance that leads nowhere is worse than its absence, so the
    /// picker hides rather than disables when there is no session.
    @Test("no session means no upload affordance")
    func noSessionNoAffordance() async {
        let composer = NoteAttachmentComposer(noteId: "note-1", filler: nil)
        #expect(!composer.canUpload)
        #expect(await composer.upload(filename: "a", mimeType: "b", bytes: Data()) == nil)
    }

    @Test("detaching reaches the core, which owns the dereference")
    func detachReachesTheCore() async {
        let filler = ScriptedUploader(result: .success("x"))
        let composer = NoteAttachmentComposer(noteId: "note-1", filler: filler)

        #expect(await composer.detach(attachmentId: "att-1"))
        #expect(filler.detached == ["att-1"])
    }

    @Test("a failed detach is mapped and reported")
    func detachFailureIsMapped() async {
        let filler = ScriptedUploader(
            result: .success("x"),
            detachFailure: SyncError.Locked
        )
        let composer = NoteAttachmentComposer(noteId: "note-1", filler: filler)

        #expect(await composer.detach(attachmentId: "att-1") == false)
        guard case let .failed(error) = composer.state else {
            Issue.record("a failed detach must leave a failure state")
            return
        }
        #expect(error.code != ErrorMapping.unrecognised.code)
    }

    /// The platform's own answer, and the one type that promises nothing
    /// rather than a guess from the extension.
    @Test("a mime type comes from the platform and falls back honestly")
    func mimeTypesAreNotGuessed() {
        #expect(
            NoteAttachmentComposer.mimeType(for: URL(fileURLWithPath: "/tmp/a.png"))
                == "image/png"
        )
        #expect(
            NoteAttachmentComposer.mimeType(for: URL(fileURLWithPath: "/tmp/a.pdf"))
                == "application/pdf"
        )
        #expect(
            NoteAttachmentComposer.mimeType(for: URL(fileURLWithPath: "/tmp/a.wat"))
                == "application/octet-stream",
            "an unknown extension promises nothing rather than guessing"
        )
    }

    /// The manifest's filename is what binds a block to an attachment (§Q4),
    /// so a captured photo's name is worth being readable and ordered.
    @Test("a captured name sorts by when it was taken")
    func capturedNamesSort() {
        let earlier = NoteAttachmentComposer.capturedName(
            at: Date(timeIntervalSince1970: 1_760_000_000)
        )
        let later = NoteAttachmentComposer.capturedName(
            at: Date(timeIntervalSince1970: 1_760_000_600)
        )
        #expect(earlier < later, "\(earlier) should sort before \(later)")
        #expect(earlier.hasSuffix(".jpg"))
        #expect(!earlier.contains(":"), "a colon is not a safe filename byte")
    }
}
