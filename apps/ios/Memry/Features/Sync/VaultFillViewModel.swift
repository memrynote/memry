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
// apply. Their cursors did not advance, so a later run retries them. A vault
// that returns some of them is a vault the screen must say something about
// rather than render as complete.

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
        /// This device has everything the window covers. `summary` is `nil`
        /// when the gate answered "already complete" and nothing ran.
        case filled
        /// The pull threw. **Whatever arrived first is still there**, so this
        /// is rendered beside the vault's contents and never in place of them.
        case failed(UserFacingError)
    }

    /// What sits above the vault's contents. Never instead of them.
    enum Banner: Equatable {
        case none
        /// The run, as a compact strip; `nil` before the first tick.
        case progress(SyncProgress?)
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

    init(filler: any VaultFilling) {
        self.filler = filler
    }

    /// Until the gate answers and while the run goes. The vault's own sync
    /// passes wait for this to end: started first, a pass takes the core's
    /// pass gate and pulls the whole feed unwindowed, with the first sync and
    /// its progress queued behind it.
    var isPending: Bool {
        switch phase {
        case .checking, .filling: true
        case .filled, .failed: false
        }
    }

    /// `.checking` is one local row and shows nothing: a banner that flashed
    /// up on every launch of a synced vault would be noise.
    var banner: Banner {
        switch phase {
        case .checking: .none
        case let .filling(progress): .progress(progress)
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

    private func run() async {
        phase = .filling(nil)
        let start = ContinuousClock.now
        Log.sync.notice("a first sync started")
        do {
            let summary = try await filler.firstSync { [weak self] progress in
                self?.report(progress)
            }
            SyncTelemetry.bootstrapInteractive(summary, since: start)
            self.summary = summary
            Log.sync.notice("a first sync finished", .count(Int(summary.metadataApplied)))
            phase = .filled
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("a first sync did not finish", .code(mapped.code))
            phase = .failed(mapped)
        }
        let elapsed = UInt64(max(0, (ContinuousClock.now - start) / .milliseconds(1)))
        Log.sync.notice("the first sync ran for", .milliseconds(elapsed))
        landed += 1
    }

    /// One tick from the core, already hopped to this actor by
    /// ``SyncProgressRelay``.
    ///
    /// **Guarded on the phase.** The hop is asynchronous, so a tick enqueued
    /// just before the run threw can arrive after `.failed` is on screen;
    /// without this guard it would put the progress bar back and hide the
    /// reason. Nothing outside a running pull may move this screen.
    private func report(_ progress: SyncProgress) {
        guard case let .filling(previous) = phase else { return }
        if previous?.phase != progress.phase { Self.logReached(progress) }
        phase = .filling(progress)
        if landedAgain(after: previous, progress) { landed += 1 }
    }

    /// Metadata applied in one re-read of the lists. A tick lands a hundred
    /// items, and re-reading a vault of thousands on each would hold the core
    /// queue the screens read through.
    static let landedStride: UInt64 = 500

    /// A new pass (the refs pass files deletes), every `landedStride` items
    /// of metadata, and its last item. Bodies change no list row.
    private func landedAgain(after previous: SyncProgress?, _ progress: SyncProgress) -> Bool {
        if previous?.phase != progress.phase {
            landedThrough = 0
            return true
        }
        guard progress.phase == .metadata,
              progress.completed >= landedThrough + Self.landedStride || progress.completed == progress.total
        else { return false }
        landedThrough = progress.completed
        return true
    }

    /// One diagnostic line per pass, not per tick: the bodies pass alone
    /// ticks hundreds of times.
    private static func logReached(_ progress: SyncProgress) {
        let total = LogDetail.count(Int(progress.total))
        switch progress.phase {
        case .refs: Log.sync.notice("the first sync is reading refs", total)
        case .metadata: Log.sync.notice("the first sync is pulling metadata", total)
        case .bodies: Log.sync.notice("the first sync is pulling bodies", total)
        case .done: Log.sync.notice("the first sync is finishing", total)
        }
    }
}
