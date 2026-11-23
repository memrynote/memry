import Foundation
import MemryCore
import Observation

// T237, the state half. The first sync of one opened vault (FR-028).
//
// **The vault is usable in every phase.** The screen draws the vault's
// contents under whatever this model says, so a first sync that runs for
// minutes, or never finishes, still leaves every note that has arrived
// readable. `banner` is the only thing a phase decides, and `landed` tells the
// lists on screen when to re-read while the run fills them.
//
// **Four phases, and the failure is not one of the empty ones.** A pull that
// throws part way through has still landed every note it applied before the
// throw — metadata lands before bodies and each pass is durable as it goes —
// so `.failed` carries a reason to show *beside* the list, never instead of
// it. The same rule has fired twice in this codebase: a `GET /sync/vaults`
// reader once used `filter_map` and reported "no vaults" against an account
// holding four.
//
// **No Cancel** (spec-defect 108). There is no `.cancelling` case and no
// method that would stop a run, because the bindings expose nothing that
// could. A user may leave the screen; the run finishes anyway, and its
// progress is durable, so a process killed mid-run resumes where it stopped.
//
// **`metadataCorrupt` and `bodiesStopped` are not failures and are not
// hidden.** The core's own doc says so: they are the items this device could
// not open and the documents whose body pull stopped at an update it could not
// apply. A stopped body's cursor did not advance, so a later run retries it; an
// unopened item may never be pulled again, so its copy promises nothing. A vault
// that returns some of them is a vault the screen must say something about
// rather than render as complete.
//
// **The drain (#5233).** With partial pack coverage the first sync leaves
// bodies owed. After it, and after a gate that answered "already complete",
// `.draining` asks the core for rounds while the app is in the foreground, a
// round pulled something and some are still owed. A round that pulled nothing
// with bodies still owed (a 429, a lost network) pauses the drain, and the
// next foreground resumes it. The vault's passes are not held for it: a round
// holds the core's pass gate for one bounded round.

@MainActor
@Observable
final class VaultFillViewModel {
    /// Where the fill is.
    enum Phase: Equatable {
        /// `isFirstSyncComplete()`. **No request is made in this phase.**
        case checking
        /// The pull is running. The payload is the last tick, or `nil` before
        /// the first one — which is a real state on a slow first round trip
        /// and is rendered as words rather than as a bar at zero.
        case filling(SyncProgress?)
        /// The first sync is over and owed bodies are being pulled, round
        /// after round, while the app is in the foreground. The payload is
        /// the last tick of this drain, or `nil` before the first one.
        case draining(SyncProgress?)
        /// The first sync is over and no drain is running. Bodies may still be
        /// owed, when the app left the foreground, a round pulled nothing or
        /// failed, or the screen went away.
        case filled
        /// The pull threw. **Whatever arrived first is still there**, so this
        /// is rendered beside the vault's contents and never in place of them.
        case failed(UserFacingError)
    }

    /// What sits above the vault's contents. Never instead of them.
    enum Banner: Equatable {
        case none
        case failure(UserFacingError)
        /// The run finished, and some of it could not be opened.
        case incomplete(String)
    }

    private(set) var phase: Phase = .checking

    /// Bumped each time the run has landed rows a list shows, so a list on
    /// screen re-reads mid-run rather than only once it ends.
    private(set) var landed = 0
    /// Metadata items the last bump covered.
    private var landedThrough: UInt64 = 0

    /// What the run did, or `nil` when no run happened on this screen.
    private(set) var summary: FirstSyncSummary?

    /// The filler in use. Internal so the wiring suite can assert that the
    /// production graph holds the **core** filler rather than something that
    /// behaves like it — Phase 3 shipped five tiers fully tested behind fakes
    /// and never called once, and spec-defect 136 is the sixth.
    let filler: any VaultFilling

    private var hasRun = false
    /// Set by the scene. The drain asks for a round only while it is true.
    private var isForeground = true
    /// A round answered that nothing is owed. A foreground after that starts
    /// no new drain.
    private var drained = false
    /// The running drain. Owned here, not by whichever caller started it, so
    /// the scene's changes neither cancel it nor start a second one, and
    /// ``leave()`` ends it when the screen goes away.
    private var drainTask: Task<Void, Never>?

    /// Ticks heard since this screen began, and the count at which the last
    /// ``quietAfter`` passed without one. ``isQuiet`` compares the two.
    private var heard = 0
    private var quietAt: Int?
    private var quietTask: Task<Void, Never>?
    /// `Task.sleep` in production. Tests pass a pause they end themselves.
    private let pause: @Sendable (Duration) async throws -> Void

    /// How long the strip waits for a tick before it says the run is still
    /// going. A body manifest page that the server rate-limits waits up to
    /// 60 s with no tick (#5352), which left the strip frozen on its last count.
    static let quietAfter: Duration = .seconds(10)

    init(
        filler: any VaultFilling,
        pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.filler = filler
        self.pause = pause
    }

    /// The strip has shown the same count for ``quietAfter``. The core sends
    /// no tick while it waits on the server, so the strip says the run is
    /// still going rather than looking stuck.
    var isQuiet: Bool { strip != nil && quietAt == heard }

    /// A tick arrived, or a run began: the quiet stretch starts again.
    private func hear() {
        heard += 1
        quietTask?.cancel()
        let mark = heard
        quietTask = Task { [weak self, pause] in
            guard (try? await pause(Self.quietAfter)) != nil else { return }
            self?.quietAt = mark
        }
    }

    /// Until the gate answers and while the run goes. The vault's own sync
    /// passes wait for this to end: started first, a pass takes the core's
    /// pass gate and pulls the whole feed unwindowed, with the first sync and
    /// its progress queued behind it.
    var isPending: Bool {
        switch phase {
        case .checking, .filling: true
        case .draining, .filled, .failed: false
        }
    }

    /// The progress strip above the contents, or `nil` for none: while the
    /// first sync or the drain runs, once its first tick has a count to show.
    /// A drain with nothing owed sends no tick, so it never flashes a strip.
    var strip: SyncProgress? {
        switch phase {
        case let .filling(progress), let .draining(progress):
            progress.flatMap { $0.phase == .done ? nil : $0 }
        case .checking, .filled, .failed: nil
        }
    }

    /// `.checking`, `.filling` and `.draining` show no banner: the run
    /// continues in the background and the vault's contents fill in as it
    /// lands.
    var banner: Banner {
        switch phase {
        case .checking, .filling, .draining: .none
        case .filled: incomplete.map(Banner.incomplete) ?? .none
        case let .failed(error): .failure(error)
        }
    }

    /// Whether the pull left anything behind it.
    ///
    /// `nil` when it did not. One sentence rather than two numbers: a count of
    /// unreadable items is not something a user can act on, and `DESIGN.md`
    /// rejects rendering a figure the reader cannot use.
    var incomplete: String? {
        guard let summary, summary.metadataCorrupt > 0 || summary.bodiesStopped > 0 else {
            return nil
        }
        // A corrupt item may be a stale row the reconcile kept, which no later
        // sync pulls again, so only stopped bodies are promised a retry (#5247).
        guard summary.metadataCorrupt == 0 else {
            return "Some of this vault could not be opened on this \(ThisDevice.noun)."
        }
        return "Some of this vault could not be opened on this \(ThisDevice.noun). Memry will try those again next time it syncs."
    }

    /// The entry gate, and the reason `isFirstSyncComplete()` exists.
    ///
    /// It is one row of the local `meta` table and makes **no request**, so a
    /// phone with no signal reaches the vault it already has without waiting
    /// on a network to tell it so.
    ///
    /// Runs once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-running a first sync would be tens of round trips
    /// for an answer the screen already holds.
    func begin() async {
        guard !hasRun else { return }
        hasRun = true
        do {
            if try await filler.isFirstSyncComplete() {
                Log.sync.info("this vault has already had its first sync")
                phase = .filled
                await drain(showing: nil)
                return
            }
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("could not tell whether this vault has been synced", .code(mapped.code))
            // **Not** `.filled` and not a silent pass. "Could not tell" must
            // not look like "nothing wrong" — and the contents, whatever they
            // are, are rendered beneath it.
            phase = .failed(mapped)
            return
        }
        await run()
    }

    /// What the failure notice's button calls. A first sync that threw resumes
    /// at the last thing it wrote rather than starting again, so this is a
    /// real continuation and not a repeat.
    func retry() async {
        guard case .failed = phase else { return }
        await run()
    }

    /// The scene's phase, from the vault scope. Back in the foreground, a
    /// drain that the background, a round that pulled nothing, or a failed
    /// round paused continues while bodies are owed.
    func sceneChanged(active: Bool) async {
        isForeground = active
        guard active, hasRun else { return }
        await drain(showing: nil)
    }

    /// The vault screen went away: the drain asks for no further round. The
    /// round in flight finishes in the core (no `rust_future_cancel`).
    func leave() {
        drainTask?.cancel()
        quietTask?.cancel()
    }

    /// Starts the drain, or joins the one running, and returns when it ends.
    /// `showing` is the tick the strip keeps until the drain's first one, so
    /// the strip does not fade out and back in between the first sync and
    /// the drain.
    private func drain(showing carried: SyncProgress?) async {
        if drainTask == nil {
            guard case .filled = phase, isForeground, !drained else { return }
            phase = .draining(carried)
            hear()
            drainTask = Task { await drainRounds() }
        }
        await drainTask?.value
    }

    /// Owed bodies, one bounded round at a time, until none is owed, a round
    /// pulls nothing (the rest are backing off, or the network is gone), the
    /// app leaves the foreground, the screen goes away (``leave()``), or a
    /// round fails. Only "none owed" ends it for good; every other stop is a
    /// pause the next foreground resumes. A failure is quiet: the bodies stay
    /// owed and the next foreground or the note view pulls them, so it is a
    /// log line, not a banner over the vault.
    private func drainRounds() async {
        var pulled = 0
        while isForeground, !Task.isCancelled {
            do {
                let round = try await filler.drainBodies { [weak self] progress in
                    self?.reportDrain(progress)
                }
                pulled += Int(round.documents)
                if round.remaining == 0 {
                    drained = true
                    Log.sync.notice("the body drain ended")
                    break
                }
                if round.documents == 0 {
                    // Asking again at once would spin on documents that are
                    // backing off or a network that is gone.
                    Log.sync.notice("the body drain paused", .count(Int(round.remaining)))
                    break
                }
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.sync.error("a body drain round did not finish", .code(mapped.code))
                break
            }
        }
        if pulled > 0 { Log.sync.notice("the body drain pulled", .count(pulled)) }
        phase = .filled
        drainTask = nil
    }

    /// A drain tick, already on this actor. Guarded like ``report(_:)``.
    private func reportDrain(_ progress: SyncProgress) {
        guard case .draining = phase else { return }
        phase = .draining(progress)
        hear()
    }

    private func run() async {
        phase = .filling(nil)
        hear()
        let start = ContinuousClock.now
        Log.sync.notice("a first sync started")
        var carried: SyncProgress?
        do {
            let summary = try await filler.firstSync { [weak self] progress in
                self?.report(progress)
            }
            SyncTelemetry.bootstrapInteractive(summary, since: start)
            self.summary = summary
            Log.sync.notice("a first sync finished", .count(Int(summary.recordsApplied)))
            carried = strip
            phase = .filled
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("a first sync did not finish", .code(mapped.code))
            phase = .failed(mapped)
        }
        let elapsed = UInt64(max(0, (ContinuousClock.now - start) / .milliseconds(1)))
        Log.sync.notice("the first sync ran for", .milliseconds(elapsed))
        landed += 1
        await drain(showing: carried)
    }

    /// One tick from the core, already hopped to this actor by
    /// ``SyncProgressRelay``.
    ///
    /// **Guarded on the phase.** The hop is asynchronous, so a tick enqueued
    /// just before the run threw can arrive after `.failed` is on screen;
    /// without this guard it would put the progress bar back and hide the
    /// reason. Nothing outside a running pull may move this screen.
    ///
    /// The `Done` tick keeps the last count on the strip: on a partially
    /// covered vault the drain continues that count, and a strip hidden at
    /// `Done` would fade out and back in.
    private func report(_ progress: SyncProgress) {
        guard case let .filling(previous) = phase else { return }
        if previous?.phase != progress.phase { Self.logReached(progress) }
        let landedAgain = landedAgain(after: previous, progress)
        phase = .filling(progress.phase == .done ? previous : progress)
        hear()
        if landedAgain { landed += 1 }
    }

    /// Records applied in one re-read of the lists. A tick lands a hundred
    /// items, and re-reading a vault of thousands on each would hold the core
    /// queue the screens read through.
    static let landedStride: UInt64 = 500

    /// A new phase, every `landedStride` records, and the last record.
    /// Bodies change no list row.
    private func landedAgain(after previous: SyncProgress?, _ progress: SyncProgress) -> Bool {
        if previous?.phase != progress.phase {
            landedThrough = 0
            return true
        }
        guard progress.phase == .records,
              progress.completed >= landedThrough + Self.landedStride || progress.completed == progress.total
        else { return false }
        landedThrough = progress.completed
        return true
    }

    /// One diagnostic line per phase, not per tick. `scripts/bootstrap-bench`
    /// reads "the first sync is pulling bodies" as its records mark.
    private static func logReached(_ progress: SyncProgress) {
        let total = LogDetail.count(Int(progress.total ?? progress.completed))
        switch progress.phase {
        case .records: Log.sync.notice("the first sync is pulling records", total)
        case .bodies: Log.sync.notice("the first sync is pulling bodies", total)
        case .done: Log.sync.notice("the first sync is finishing", total)
        }
    }
}
