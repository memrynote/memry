import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T237, the note half. **A windowed-out body must never render as an empty
// note, and it must not be a dead end.**
//
// `first_sync`'s bodies pass is windowed to the recent thirty days (chapter 10
// §10.6.1, FR-028 "older content on demand"), so on a ninety-four-note account
// most notes arrive with their metadata and `NoteBody.present == false`. T157
// already told that apart from an empty note; what it had no way to do was
// **get the body**. `fetchNoteBody` is that, and this file is its call site's
// evidence.
//
// The store below is the note-level model of the same rule the browse tests
// use: `ScriptedNote` can only read it, and the filler is the only thing that
// can turn a not-pulled body into text. A screen that showed text without the
// fetch could not pass.

/// One note, and whether its body has been pulled onto this device.
final class NoteStore: Sendable {
    private let pulled = Mutex<Bool>(false)

    var isPulled: Bool { pulled.withLock { $0 } }
    func pull() { pulled.withLock { $0 = true } }
}

struct ScriptedNote: NotesReading {
    let store: NoteStore

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        NoteDetail(
            summary: NoteSummary(
                id: id, title: "an older note",
                folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            ),
            // `present: false` with empty text is "the body has not been
            // pulled here"; `present: true` with empty text would be "the user
            // left this note empty". They are different notes.
            body: store.isPulled
                ? NoteBody(text: "the body arrived", present: true)
                : NoteBody(text: "", present: false)
        )
    }
}

/// The only thing that can pull a body.
final class NoteFiller: VaultFilling, @unchecked Sendable {
    private let store: NoteStore
    private let failure: (any Error)?
    private let stopped: Bool
    private let calls = Mutex<Int>(0)

    init(store: NoteStore, failure: (any Error)? = nil, stopped: Bool = false) {
        self.store = store
        self.failure = failure
        self.stopped = stopped
    }

    var fetches: Int { calls.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool { true }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        .none
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        calls.withLock { $0 += 1 }
        if let failure { throw failure }
        // A pull that stopped part way leaves the body incomplete, not absent.
        store.pull()
        return BodyFetchSummary(updates: 2, baselines: 1, stopped: stopped)
    }
}

/// Refuses a read in a cancelled task, as `CoreExecutor.run` does.
private struct RefusingCancelledReads: NotesReading {
    let note: ScriptedNote

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        try Task.checkCancellation()
        return try await note.read(id: id)
    }
}

/// A pull that takes long enough for the screen's task to be cancelled
/// under it. The core's pull runs on regardless (spec-defect 108).
private final class SlowFiller: VaultFilling, @unchecked Sendable {
    private let store: NoteStore

    init(store: NoteStore) { self.store = store }

    func isFirstSyncComplete() async throws -> Bool { true }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        .none
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        // Not `Task.sleep`: that would end early on the cancel, which the
        // core's pull does not.
        await withCheckedContinuation { continuation in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { continuation.resume() }
        }
        store.pull()
        return BodyFetchSummary(updates: 1, baselines: 0, stopped: false)
    }
}

@MainActor
@Suite("T237 the on-demand body", .serialized)
struct NoteBodyFetchTests {
    private static let route = NoteRoute(id: "note-outside-the-window")

    /// **The defect, at note granularity.** A note the window left behind is
    /// read successfully and its body is not here — and that is neither an
    /// empty note nor a failure.
    @Test("a windowed-out body is not an empty note")
    func aWindowedOutBodyIsNotAnEmptyNote() async throws {
        let model = NoteReadViewModel(route: Self.route, reader: ScriptedNote(store: NoteStore()))
        await model.loadIfNeeded()
        #expect(model.preview == .notPulled)
        #expect(model.preview != .empty)
    }

    /// **The pull is what makes the body readable, and nothing else is.**
    @Test("an absent body becomes text through the fetch and through nothing else")
    func theFetchIsWhatMakesTheBodyReadable() async throws {
        let store = NoteStore()
        let filler = NoteFiller(store: store)
        let model = NoteReadViewModel(
            route: Self.route, reader: ScriptedNote(store: store), filler: filler
        )

        await model.loadIfNeeded()
        #expect(model.preview == .notPulled)
        // Re-reading as often as you like changes nothing.
        await model.reload()
        #expect(model.preview == .notPulled)
        #expect(filler.fetches == 0)

        await model.fetchBody()
        #expect(filler.fetches == 1)
        #expect(model.preview == .text("the body arrived"))
        #expect(model.fetch == .idle)
    }

    /// #3253: opening the note fetches the body itself, as desktop does for
    /// the note on screen. The open path is `loadIfNeeded` then
    /// `refreshFromRemote`, the page's `.task(id: vaultSyncPasses)`.
    @Test("opening a windowed-out note fetches its body without a tap")
    func openingFetchesTheBody() async throws {
        let store = NoteStore()
        let filler = NoteFiller(store: store)
        let model = NoteReadViewModel(
            route: Self.route, reader: ScriptedNote(store: store), filler: filler
        )
        await model.loadIfNeeded()
        await model.refreshFromRemote()
        #expect(filler.fetches == 1)
        #expect(model.preview == .text("the body arrived"))
        #expect(model.fetch == .idle)
    }

    /// The page's task can be cancelled while the pull runs. The pull lands
    /// anyway, so the page reads it rather than staying on its button.
    @Test("a pull whose page task is cancelled is still read")
    func aCancelledPageStillReadsThePull() async throws {
        let store = NoteStore()
        let model = NoteReadViewModel(
            route: Self.route,
            reader: RefusingCancelledReads(note: ScriptedNote(store: store)),
            filler: SlowFiller(store: store)
        )
        await model.loadIfNeeded()
        #expect(model.preview == .notPulled)

        let page = Task { await model.refreshFromRemote() }
        try await Task.sleep(for: .milliseconds(20))
        page.cancel()
        await page.value

        #expect(model.preview == .text("the body arrived"))
        #expect(model.fetch == .idle)
    }

    /// No filler, no button. An affordance that leads nowhere is worse than
    /// its absence, and before T237 that is all this screen could have had.
    @Test("a screen with no filler offers no download")
    func noFillerOffersNothing() async throws {
        let model = NoteReadViewModel(route: Self.route, reader: ScriptedNote(store: NoteStore()))
        #expect(model.canFetchBody == false)
        await model.fetchBody()
        #expect(model.fetch == .idle)
    }

    /// Chapter 07 §7.9: the pull stopped at an update this device could not
    /// open, the cursor did not advance, and a later fetch resumes there. It
    /// is neither a success nor a failure.
    @Test("a pull that stopped part way says so, and is neither done nor failed")
    func aStoppedPullIsItsOwnState() async throws {
        let store = NoteStore()
        let model = NoteReadViewModel(
            route: Self.route,
            reader: ScriptedNote(store: store),
            filler: NoteFiller(store: store, stopped: true)
        )
        await model.loadIfNeeded()
        await model.fetchBody()
        #expect(model.fetch == .incomplete)
        // And the text that did arrive is shown.
        #expect(model.preview == .text("the body arrived"))
    }

    /// **`UnknownNote` is permanent.** The screen offers no retry over it,
    /// because the copy carries `.blocked` and the button is gated on
    /// `.retry`.
    @Test("a refused fetch is reported as permanent, never as retryable")
    func aRefusedFetchIsPermanent() async throws {
        let store = NoteStore()
        let model = NoteReadViewModel(
            route: Self.route,
            reader: ScriptedNote(store: store),
            filler: NoteFiller(store: store, failure: SyncError.UnknownNote(id: Self.route.id))
        )
        await model.loadIfNeeded()
        await model.fetchBody()

        guard case let .failed(error) = model.fetch else {
            Issue.record("a refused fetch did not reach the failed state")
            return
        }
        #expect(error.recourse == .blocked)
        #expect(error.code != ErrorMapping.unrecognised.code)
        // The note is still here and still says what is true of it.
        #expect(model.preview == .notPulled)
    }

    /// A transport failure is the other kind: repeating it can work, so the
    /// screen may offer the button.
    @Test("a transient failure stays retryable")
    func aTransientFailureStaysRetryable() async throws {
        let store = NoteStore()
        let model = NoteReadViewModel(
            route: Self.route,
            reader: ScriptedNote(store: store),
            filler: NoteFiller(store: store, failure: SyncError.Api(source: .Transport(source: .Offline)))
        )
        await model.loadIfNeeded()
        await model.fetchBody()

        guard case let .failed(error) = model.fetch else {
            Issue.record("a transport failure did not reach the failed state")
            return
        }
        #expect(error.recourse != .blocked)
    }

    /// VERIFY-4419 #3: a find request opened onto a note whose body is not
    /// here waits for the pull, rather than resolving against no blocks.
    @Test("an unpulled body leaves the blocks unread until the pull lands")
    func anUnpulledBodyIsNotRead() async throws {
        let store = NoteStore()
        let model = NoteReadViewModel(
            route: Self.route, reader: ScriptedNote(store: store), filler: NoteFiller(store: store)
        )
        await model.loadIfNeeded()
        #expect(!model.blocksRead)

        await model.fetchBody()
        #expect(model.blocksRead)
    }

    /// A new note's body is not pulled yet, so its page fetches the body while
    /// the title holds the caret. The re-read after the fetch kept the page on
    /// screen: a `.loading` swap drew the spinner in the title's place, and the
    /// title's focus state let go of the caret it still drew, so the keys
    /// typed next went to no edit (#4893).
    @Test("the read after a fetch keeps the page on screen")
    func theReadAfterAFetchKeepsThePage() async throws {
        let store = NoteStore()
        let phases = PhaseLog()
        let model = NoteReadViewModel(
            route: Self.route, reader: PhaseWatchingReads(note: ScriptedNote(store: store), log: phases),
            filler: NoteFiller(store: store)
        )
        await model.loadIfNeeded()
        phases.model = model
        #expect(!model.blocksRead)

        await model.fetchBody()
        #expect(phases.seen.allSatisfy { if case .ready = $0 { true } else { false } }, "\(phases.seen)")
        #expect(model.preview == .text("the body arrived"))
        #expect(model.blocksRead)
    }
}

/// The page's phase each time the note is read.
@MainActor
private final class PhaseLog {
    weak var model: NoteReadViewModel?
    var seen: [NoteReadViewModel.Phase] = []
}

private struct PhaseWatchingReads: NotesReading {
    let note: ScriptedNote
    let log: PhaseLog

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }

    func read(id: String) async throws -> NoteDetail? {
        await MainActor.run { if let phase = log.model?.phase { log.seen.append(phase) } }
        return try await note.read(id: id)
    }
}
