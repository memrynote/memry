import Foundation
import MemryCore
import SwiftUI
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
// | a remote url is ordinary content, not a failed download | §Q4                     |
// | an ambiguous basename is refused, never guessed         | §Q4                     |
// | only attachment-bearing blocks are resolved             | a bookmark url is not a vault path |
// | a run holding a stale list skips a file another run landed | one download per file |
// | a later run skips a permanent failure and asks again after any other | desktop `asksOnSync` |
// | a cancelled fetch asks for no further picture           | REVIEW-5587: no repeat download per pass |
// | the page asks for pictures before the body pull answers | REVIEW-5587: no network wait on open |

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
        #expect(model.attachmentFetches.isEmpty, "a landed download still shows as running")
    }

    /// #5644, `SettingsCopy.downloadFooter`: "An attachment you open always
    /// downloads." Opening judges the path unmetered whatever the setting, so
    /// the core's unmetered-only default does not hold an opened picture back.
    @Test("opening a note downloads its pictures on a metered path")
    func openingDownloadsOnAMeteredPath() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: "att-1")
        )
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .cellular)
        )
        await model.loadIfNeeded()
        await model.fetchWaitingAttachments()

        #expect(filler.judged == [.wifi])
    }

    @Test("opening a note offline asks for nothing")
    func openingOfflineAsksNothing() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = ScriptedAttachmentFiller(
            summary: AttachmentFetchSummary(downloaded: false, deferred: true, bytes: 0, localPath: nil)
        )
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .offline)
        )
        await model.loadIfNeeded()
        await model.fetchWaitingAttachments()

        #expect(filler.fetched.isEmpty)
        #expect(model.attachmentFetches.isEmpty)
    }

    /// The placeholder goes from "Not downloaded yet" to downloading to the
    /// failure, and a second run while the first downloads asks for nothing.
    @Test("an on-open download shows while it runs and after it fails")
    func onOpenDownloadIsVisible() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = GatedAttachmentFiller(failure: .Locked)
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.loadIfNeeded()
        #expect(model.attachmentFetches.isEmpty)

        let first = Task { await model.fetchWaitingAttachments() }
        await filler.waitUntilFetching()
        #expect(model.attachmentFetches["att-1"] == .downloading)

        await model.fetchWaitingAttachments()
        #expect(filler.fetches == 1, "a second run fetched bytes already downloading")

        filler.finish()
        await first.value
        #expect(model.attachmentFetches["att-1"] == .failed(ErrorMapping.userFacing(SyncError.Locked)))
        #expect(
            NoteAttachmentBinding.of("picture.png") { model.attachments[$0] ?? .unknown }
                == .waitingFor("att-1"),
            "a failed download keeps its placeholder"
        )
    }

    /// `NotePageLoad` restarts its task on every sync pass. A pass that ends
    /// mid-download cancels the run doing it, and the restarted run skips the
    /// attachment as already downloading. The picture still appears.
    @Test("a sync pass that restarts the page mid-download still shows the picture")
    func restartMidDownloadStillRebinds() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let filler = GatedAttachmentFiller(failure: nil, onLanded: {
            reader.rebind("picture.png", to: .bound(attachment: cached(id: "att-1", localPath: "att-1")))
        })
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.loadIfNeeded()

        let first = Task { await model.fetchWaitingAttachments() }
        await filler.waitUntilFetching()
        first.cancel()
        await model.fetchWaitingAttachments()
        filler.finish()
        await first.value

        #expect(filler.fetches == 1)
        guard case let .bound(attachment) = model.attachments["picture.png"] else {
            Issue.record("the attachment did not rebind after its bytes landed")
            return
        }
        #expect(attachment.localPath == "att-1", "the landed picture stayed a placeholder")
        #expect(model.attachmentFetches.isEmpty)
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

/// Runs of the note page's on-open download: two at once, one a sync pass
/// cancelled, one after a failure, and the one the open starts.
@Suite("Note attachment download runs")
@MainActor
struct NoteAttachmentRunTests {
    /// REVIEW-5685: a pass restarts the page while a run downloads one of two
    /// files. The new run lands the other; the first run, still holding both
    /// in its list, must not download it again.
    @Test("a run holding a stale list skips a file another run landed")
    func staleRunSkipsALandedFile() async {
        let urls = ["att-a": "a.png", "att-b": "b.png"]
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "a.png"), imageBlock(url: "b.png")],
            bindings: [
                "a.png": .bound(attachment: cached(id: "att-a", localPath: nil)),
                "b.png": .bound(attachment: cached(id: "att-b", localPath: nil))
            ]
        )
        let filler = FirstFetchGatedFiller { id in
            if let url = urls[id] { reader.rebind(url, to: .bound(attachment: cached(id: id, localPath: id))) }
        }
        let model = NoteReadViewModel(
            route: route, reader: reader, filler: filler,
            reachability: FixedPath(path: .wifi)
        )
        await model.loadIfNeeded()

        let first = Task { await model.fetchWaitingAttachments() }
        await filler.waitUntilFetching()
        await model.fetchWaitingAttachments()
        filler.finish()
        await first.value

        #expect(filler.fetched.sorted() == ["att-a", "att-b"], "a file was downloaded twice")
        #expect(model.attachmentFetches.isEmpty)
    }

    /// REVIEW-5685, desktop `asksOnSync`: a file asking cannot bring stays
    /// failed through the next pass instead of going back to the server and
    /// flickering Downloading. A failure asking again can fix is asked again.
    @Test("a later run skips a permanent failure and asks again after any other")
    func passesSkipPermanentFailures() async {
        let reader = ScriptedAttachments(
            blocks: [imageBlock(url: "picture.png")],
            bindings: ["picture.png": .bound(attachment: cached(id: "att-1", localPath: nil))]
        )
        let unverified = SyncError.AttachmentUnverified(deviceId: "device")
        let corrupt = SyncError.AttachmentCorrupt(what: "chunk")
        #expect(ErrorMapping.userFacing(unverified).recourse == .blocked)
        #expect(ErrorMapping.userFacing(corrupt).recourse == .retry)
        let pending = AttachmentFetchSummary(downloaded: false, deferred: true, bytes: 0, localPath: nil)

        let refused = ScriptedAttachmentFiller(summary: pending, failure: unverified)
        let refusedModel = NoteReadViewModel(
            route: route, reader: reader, filler: refused, reachability: FixedPath(path: .wifi)
        )
        await refusedModel.loadIfNeeded()
        await refusedModel.fetchWaitingAttachments()
        await refusedModel.fetchWaitingAttachments()
        #expect(refused.fetched == ["att-1"], "a permanent failure went back to the server")
        #expect(refusedModel.attachmentFetches["att-1"] == .failed(ErrorMapping.userFacing(unverified)))

        let damaged = ScriptedAttachmentFiller(summary: pending, failure: corrupt)
        let damagedModel = NoteReadViewModel(
            route: route, reader: reader, filler: damaged, reachability: FixedPath(path: .wifi)
        )
        await damagedModel.loadIfNeeded()
        await damagedModel.fetchWaitingAttachments()
        await damagedModel.fetchWaitingAttachments()
        #expect(damaged.fetched == ["att-1", "att-1"])
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
        let filler = HeldAttachmentFiller()
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
        let filler = HeldAttachmentFiller()
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
