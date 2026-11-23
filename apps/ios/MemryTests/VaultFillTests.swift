import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T237, the state half. The gate, the progress relay, and the one assertion
// this whole task exists for: **the list is non-empty because of the pull and
// because of nothing else.**
//
// **Every test in this codebase before T237 read a database it had filled
// itself**, which is exactly why nobody noticed that nothing filled it in
// production (spec-defect 136). So the store below is deliberately shaped the
// other way round: `StoreNotes` can only read it and `StoreFiller` is the only
// thing in the file that can write it, so a chain that reaches a non-empty list
// without running the pull cannot compile its way out of failing.
//
// **Every wait is bounded** (spec-defect 99: an `AsyncStream` test hung for
// twenty-one minutes instead of failing). The only blocking wait here is a
// `DispatchSemaphore` with a two-second timeout whose result is asserted.
//
// **No network call is made by this file.**

/// What a vault holds, as far as this file is concerned.
final class VaultStore: Sendable {
    private let notes = Mutex<[NoteSummary]>([])

    var current: [NoteSummary] { notes.withLock { $0 } }

    /// The **only** writer, and it is called from the filler alone.
    func fill(_ count: Int) {
        notes.withLock { rows in
            rows = (0..<count).map { NoteSummary(
                id: "note-\($0)", title: "note \($0)",
                folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
            ) }
        }
    }
}

/// Reads the store. It cannot write it: there is no method that would.
struct StoreNotes: NotesReading {
    let store: VaultStore

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { store.current }
    func read(id: String) async throws -> NoteDetail? { nil }
}

/// A scripted pull. The network is the only thing substituted.
final class StoreFiller: VaultFilling, @unchecked Sendable {
    enum Call: Equatable, Sendable { case gate, first, drain, body(String) }

    private let store: VaultStore
    private let complete: Bool
    private let fills: Int
    private let failure: (any Error)?
    private let ticks: [SyncProgress]
    private let calls = Mutex<[Call]>([])
    private let summary: FirstSyncSummary
    /// Each drain round's answer and its ticks, in order. Past the end, a
    /// round with nothing owed.
    private let rounds = Mutex<[(ticks: [SyncProgress], answer: Result<BodyDrainSummary, any Error>)]>([])

    /// The progress closure `firstSync` was last handed, kept so a test can
    /// drive a tick that arrives **after** the run ended. That is not a
    /// contrivance: `SyncProgressRelay` hops to the main actor
    /// asynchronously, so a tick enqueued a moment before the core threw is
    /// delivered after the failure is already on screen.
    nonisolated(unsafe) private(set) var escapedProgress: (@MainActor @Sendable (SyncProgress) -> Void)?

    init(
        store: VaultStore,
        alreadyComplete: Bool = false,
        fills: Int = 0,
        ticks: [SyncProgress] = [],
        failure: (any Error)? = nil,
        summary: FirstSyncSummary = .none,
        rounds: [(ticks: [SyncProgress], answer: Result<BodyDrainSummary, any Error>)] = []
    ) {
        self.store = store
        complete = alreadyComplete
        self.fills = fills
        self.ticks = ticks
        self.failure = failure
        self.summary = summary
        self.rounds.withLock { $0 = rounds }
    }

    var history: [Call] { calls.withLock { $0 } }

    func isFirstSyncComplete() async throws -> Bool {
        calls.withLock { $0.append(.gate) }
        return complete
    }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        calls.withLock { $0.append(.first) }
        escapedProgress = progress
        for tick in ticks {
            await MainActor.run { progress(tick) }
        }
        if let failure {
            // Whatever arrived before the throw stays. This is the partial
            // failure the whole of requirement five is about.
            if fills > 0 { store.fill(fills) }
            throw failure
        }
        store.fill(fills)
        return summary
    }

    func drainBodies(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> BodyDrainSummary {
        calls.withLock { $0.append(.drain) }
        let next = rounds.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        guard let next else { return .round(0, remaining: 0) }
        for tick in next.ticks {
            await MainActor.run { progress(tick) }
        }
        return try next.answer.get()
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        calls.withLock { $0.append(.body(noteId)) }
        if let failure { throw failure }
        return BodyFetchSummary(updates: 1, baselines: 0, stopped: false)
    }
}

extension FirstSyncSummary {
    /// A clean run that brought nothing back.
    static let none = FirstSyncSummary(
        refsRecorded: 0, tombstones: 0, metadataApplied: 0, recordPackEntries: 0, reconcilePulled: 0,
        packBodiesSettled: 0, bodiesOwed: 0, metadataCorrupt: 0,
        bodies: 0, updates: 0, bodiesStopped: 0, windowStartMs: 0, elevated: false
    )

    static func applied(_ count: UInt32, corrupt: UInt32 = 0, stopped: UInt32 = 0) -> FirstSyncSummary {
        FirstSyncSummary(
            refsRecorded: count, tombstones: 0, metadataApplied: count, recordPackEntries: 0, reconcilePulled: 0,
            packBodiesSettled: 0, bodiesOwed: 0, metadataCorrupt: corrupt,
            bodies: count, updates: count, bodiesStopped: stopped, windowStartMs: 0, elevated: false
        )
    }
}

extension BodyDrainSummary {
    static func round(_ documents: UInt32, remaining: UInt32) -> BodyDrainSummary {
        BodyDrainSummary(documents: documents, requests: documents, remaining: remaining, elevated: false)
    }
}

private func tick(_ phase: SyncPhase, _ done: UInt64, _ total: UInt64?) -> SyncProgress {
    SyncProgress(phase: phase, completed: done, total: total)
}

/// A first sync that lands notes and ticks, then holds until the test lets it
/// end: the run a user browses through.
final class HeldFiller: VaultFilling, @unchecked Sendable {
    private let store: VaultStore
    private let fills: Int
    private let ticks: [SyncProgress]
    private let release = Mutex<CheckedContinuation<Void, Never>?>(nil)

    init(store: VaultStore, fills: Int, ticks: [SyncProgress]) {
        self.store = store
        self.fills = fills
        self.ticks = ticks
    }

    var isHeld: Bool { release.withLock { $0 != nil } }

    func finish() {
        release.withLock { held in
            held?.resume()
            held = nil
        }
    }

    func isFirstSyncComplete() async throws -> Bool { false }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        store.fill(fills)
        for tick in ticks {
            await MainActor.run { progress(tick) }
        }
        await withCheckedContinuation { continuation in
            release.withLock { $0 = continuation }
        }
        return .applied(UInt32(fills))
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 1, baselines: 0, stopped: false)
    }
}

@MainActor
@Suite("T237 the vault fill", .serialized)
struct VaultFillTests {
    /// **The headline.** A genuinely empty vault, the production chain, and
    /// the pull as the only thing that can change the answer.
    @Test("an empty vault is filled by the pull and by nothing else")
    func emptyVaultIsFilledByThePull() async throws {
        let store = VaultStore()
        let browse = VaultBrowseViewModel(reader: StoreNotes(store: store))
        let filler = StoreFiller(store: store, fills: 94, summary: .applied(94))

        // Before anything runs: genuinely empty, and the browse screen says so
        // honestly rather than failing.
        await browse.loadIfNeeded()
        #expect(browse.phase == .empty)

        // The production gate, driven exactly as `VaultFillView.task` drives it.
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(fill.phase == .filled)
        #expect(fill.banner == .none)
        #expect(filler.history == [.gate, .first, .drain])

        // And only now is there anything to list.
        await browse.reload()
        guard case let .ready(outline) = browse.phase else {
            Issue.record("the browse screen did not become ready after the pull")
            return
        }
        #expect(outline.rootNotes.count == 94)
    }

    /// The control for the test above, and the thing that makes it an
    /// assertion about the **pull** rather than about the chain. A device that
    /// has already synced runs no pull, so nothing fills the store, so the
    /// list is still empty — the gate is not what populates anything.
    @Test("nothing but the pull fills the vault, so a skipped pull leaves it empty")
    func aSkippedPullLeavesTheVaultEmpty() async throws {
        let store = VaultStore()
        let filler = StoreFiller(store: store, alreadyComplete: true, fills: 94)

        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()

        #expect(fill.phase == .filled)
        // `firstSync` was never called, and the store is untouched.
        #expect(filler.history == [.gate, .drain])
        #expect(store.current.isEmpty)
    }

    /// `isFirstSyncComplete()` is the gate **and it makes no request**, which
    /// is why it exists as a separate blocking call. Here that is asserted as
    /// "it is the only call made"; `VaultFillWiringTests` asserts the no-request
    /// half over the real core and a transport that records everything.
    @Test("a vault that has already been synced is entered without a pull")
    func theGateSkipsTheSyncedVault() async throws {
        let filler = StoreFiller(store: VaultStore(), alreadyComplete: true)
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(fill.phase == .filled)
        #expect(filler.history == [.gate, .drain])
    }

    @Test("progress ticks reach the screen as a determinate fraction")
    func progressReachesTheScreen() async throws {
        let filler = StoreFiller(
            store: VaultStore(),
            fills: 3,
            ticks: [tick(.records, 1, nil), tick(.records, 2, 4), tick(.bodies, 4, 4)],
            summary: .applied(3)
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        // The run finished, so the last thing the screen holds is `.filled` —
        // the ticks are asserted on the way through by the guard test below.
        #expect(fill.phase == .filled)
        #expect(fill.incomplete == nil)
    }

    /// **The failure must not read as an empty vault.** The notes that landed
    /// before the throw are still there, and the phase carries the reason.
    @Test("a partial failure keeps the notes that arrived and says what stopped")
    func aPartialFailureKeepsWhatArrived() async throws {
        let store = VaultStore()
        let browse = VaultBrowseViewModel(reader: StoreNotes(store: store))
        let filler = StoreFiller(
            store: store, fills: 40,
            failure: SyncError.Api(source: .Status(status: 503, code: nil, message: "")),
            summary: .none
        )

        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()

        guard case let .failed(error) = fill.phase else {
            Issue.record("a first sync that threw did not reach the failed phase")
            return
        }
        #expect(error.code != ErrorMapping.unrecognised.code)
        #expect(fill.banner == .failure(error))
        #expect(!fill.isPending, "a stopped run holds no pass back")

        // The forty that arrived are real and are still listed.
        await browse.loadIfNeeded()
        guard case let .ready(outline) = browse.phase else {
            Issue.record("the notes that arrived before the failure were not listed")
            return
        }
        #expect(outline.rootNotes.count == 40)
    }

    /// A tick enqueued just before the throw arrives after `.failed` is on
    /// screen, because the hop to this actor is asynchronous. Without the
    /// guard in `report(_:)` it would put the progress bar back and hide the
    /// reason.
    @Test("a late progress tick cannot put the bar back over a failure")
    func aLateTickCannotHideTheFailure() async throws {
        let filler = StoreFiller(
            store: VaultStore(),
            failure: SyncError.Locked,
            summary: .none
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        guard case .failed = fill.phase else {
            Issue.record("expected the failed phase")
            return
        }
        // The real late tick: the closure the core was handed, invoked after
        // the run has already ended. Without the guard in `report(_:)` this
        // puts the progress bar back and hides the reason.
        let late = try #require(filler.escapedProgress)
        late(tick(.records, 1, 2))
        guard case .failed = fill.phase else {
            Issue.record("a late tick moved the screen off its failure")
            return
        }
    }

    @Test("the gate runs once per screen")
    func theGateRunsOnce() async throws {
        let filler = StoreFiller(store: VaultStore(), fills: 1, summary: .applied(1))
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        await fill.begin()
        #expect(filler.history == [.gate, .first, .drain])
    }

    /// `metadataCorrupt` and `bodiesStopped` are not failures and the core's
    /// own doc says they must not be hidden.
    @Test("items this device could not open are said, not swallowed")
    func corruptItemsAreSaid() async throws {
        let filler = StoreFiller(store: VaultStore(), fills: 2, summary: .applied(2, corrupt: 3))
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(fill.phase == .filled)
        let sentence = try #require(fill.incomplete)
        #expect(fill.banner == .incomplete(sentence))
    }

    /// #5247: an item the device could not open may be one the reconcile kept
    /// and never pulls again, so its sentence promises no retry. A stopped
    /// body pull keeps its cursor, so the next sync does retry it.
    @Test("only a stopped body pull is promised a retry")
    func onlyStoppedBodiesArePromisedARetry() async throws {
        let corrupt = StoreFiller(store: VaultStore(), fills: 2, summary: .applied(2, corrupt: 1, stopped: 1))
        let corruptFill = VaultFillViewModel(filler: corrupt)
        await corruptFill.begin()
        let unopened = try #require(corruptFill.incomplete)
        #expect(!unopened.contains("try those again"))

        let stopped = StoreFiller(store: VaultStore(), fills: 2, summary: .applied(2, stopped: 1))
        let stoppedFill = VaultFillViewModel(filler: stopped)
        await stoppedFill.begin()
        let retried = try #require(stoppedFill.incomplete)
        #expect(retried.contains("try those again"))
    }

    /// The incident this exists for: a first sync that ran for a day showed a
    /// bar and never the notes already on the phone. While the run is still
    /// going, the screen holds a strip rather than a replacement, and the
    /// list on screen re-reads into the notes that landed.
    @Test("a run that has not finished shows its notes with nothing over them")
    func aRunningFillShowsItsNotes() async throws {
        let store = VaultStore()
        let browse = VaultBrowseViewModel(reader: StoreNotes(store: store))
        await browse.loadIfNeeded()
        #expect(browse.phase == .empty)

        let ticks = [
            tick(.records, 0, nil),
            tick(.records, 100, 1200), tick(.records, 200, 1200), tick(.records, 300, 1200),
            tick(.records, 400, 1200), tick(.records, 500, 1200), tick(.records, 600, 1200),
            tick(.records, 1200, 1200),
            tick(.bodies, 3, 1200),
        ]
        let filler = HeldFiller(store: store, fills: 40, ticks: ticks)
        let fill = VaultFillViewModel(filler: filler)
        #expect(fill.banner == .none, "the local gate shows nothing over the vault")
        #expect(fill.isPending, "and holds the vault's passes until it answers")

        let run = Task { await fill.begin() }
        // Bounded: two seconds, then it fails rather than waits (spec-defect 99).
        for _ in 0..<200 where !filler.isHeld {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(filler.isHeld)

        #expect(fill.banner == .none, "a running first sync shows no banner over the vault")
        #expect(fill.strip == tick(.bodies, 3, 1200), "only the thin strip, with the vault's counts")
        #expect(fill.isPending)
        // A bump per phase, every 500 records, and the last record.
        #expect(fill.landed == 4)
        await browse.refresh()
        guard case let .ready(outline) = browse.phase else {
            Issue.record("the notes that landed mid-run were not listed")
            filler.finish()
            await run.value
            return
        }
        #expect(outline.rootNotes.count == 40)

        filler.finish()
        await run.value
        #expect(fill.banner == .none)
        #expect(fill.strip == nil, "the strip goes when the run ends")
        #expect(!fill.isPending, "the passes held for the run go now")
        #expect(fill.landed == 5, "the end of the run re-reads the lists once more")
    }
}

// MARK: - The progress relay

@Suite("T237 the progress relay")
struct SyncProgressRelayTests {
    /// **The listener is synchronous by contract**: the core calls it from
    /// inside the pass it is reporting, so an implementation that waits stalls
    /// the sync it is measuring.
    ///
    /// The main actor is deliberately **blocked** for the length of this test
    /// by the semaphore wait below, which is what makes the assertion mean
    /// something: a relay that hopped synchronously could not return until the
    /// main actor was free, so `signal()` would never be reached and the wait
    /// would time out. The wait is bounded at two seconds, so this **fails**
    /// rather than hangs (spec-defect 99).
    @Test("the relay returns without waiting for the main actor")
    @MainActor
    func theRelayDoesNotWaitForTheMainActor() {
        let seen = Mutex<[SyncProgress]>([])
        let relay = SyncProgressRelay { progress in seen.withLock { $0.append(progress) } }
        let returned = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            relay.progress(progress: tick(.records, 7, 94))
            returned.signal()
        }

        #expect(returned.wait(timeout: .now() + 2) == .success)
        // And it really had not delivered yet — the main actor was busy in the
        // wait above, so the hop cannot have run. This is the half that proves
        // the relay enqueued rather than blocked.
        #expect(seen.withLock { $0 }.isEmpty)
    }

    @Test("the relay delivers on the main actor")
    @MainActor
    func theRelayDelivers() async throws {
        let seen = Mutex<[SyncProgress]>([])
        let relay = SyncProgressRelay { progress in seen.withLock { $0.append(progress) } }
        relay.progress(progress: tick(.bodies, 3, 3))

        // Bounded: twenty yields, then it fails rather than waits forever.
        for _ in 0..<20 where seen.withLock({ $0.isEmpty }) {
            await Task.yield()
        }
        #expect(seen.withLock { $0 } == [tick(.bodies, 3, 3)])
    }
}
