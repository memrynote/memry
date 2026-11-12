import Foundation
import MemryCore
import Observation

// Full-text search over one vault.
//
// **Why this exists.** The browse screen filtered the list it already held,
// which matches titles and only titles — a vault whose word is in a note's body
// answered "no results" while holding the note. The core has had an FTS index
// since the index tier landed; it had no way across the FFI until now.
//
// **The index is opened once, lazily, and held.** `Vault.search()` opens
// `index.db` and rebuilds it when the file cannot be trusted, so it is not
// free; minting one per keystroke would pay that cost on every letter.
//
// **Typing does not reindex.** The vault's index owner (`VaultSearchIndex`)
// reindexes after sync passes and writes; the query in the box runs again
// each time it finishes.
//
// **Results are the core's ranking, never re-sorted.** bm25 ordering is what
// the query returned; a shell that sorted by date would be answering a
// different question than the one the user asked.

/// The search surface over one vault.
protocol VaultSearching: Sendable {
    /// Notes and journals matching `query`, best first. A query carrying no
    /// searchable term returns **empty** — an empty box is not a request for
    /// the whole vault.
    func notes(query: String, limit: UInt32) async throws -> [SearchResult]
    /// Tasks matching `query`, best first (TP056). Its own ranking: a bm25
    /// score is relative to its table, so the two lists are never merged.
    func tasks(query: String, limit: UInt32) async throws -> [SearchResult]
    /// Brings the index up to date. Idempotent, and safe on any schedule.
    func reindex() async throws
    /// Every note linking to this one (N800).
    func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink]
    /// Every note or journal day linking to `targetId` (a note or journal
    /// record id), each with its kind and, for a day, its date (JP052).
    func linksTo(targetId: String, order: BacklinkOrder) async throws -> [BacklinkRow]
    /// Notes and journal days spelling `targetId`'s title or an alias as plain
    /// text without linking to it (#3330). Matching is the core's.
    func unlinkedMentions(targetId: String) async throws -> [UnlinkedMention]
}

/// The production searcher: the core's own `Search`, over the shell's serial
/// core queue.
struct CoreVaultSearch: VaultSearching {
    private let search: Search
    private let executor: CoreExecutor

    /// - Throws: when `index.db` can be neither opened nor rebuilt. The caller
    ///   then has no search, which is a smaller failure than a browse screen
    ///   that will not open — hence the optional handoff in
    ///   ``VaultBrowseViewModel``.
    init(vault: Vault, executor: CoreExecutor) throws {
        search = try vault.search()
        self.executor = executor
    }

    func notes(query: String, limit: UInt32) async throws -> [SearchResult] {
        let search = search
        return try await executor.run { try search.notes(query: query, limit: limit) }
    }

    func tasks(query: String, limit: UInt32) async throws -> [SearchResult] {
        let search = search
        return try await executor.run { try search.tasks(query: query, limit: limit) }
    }

    func reindex() async throws {
        let search = search
        _ = try await executor.run { try search.reindex() }
    }

    func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink] {
        let search = search
        return try await executor.run {
            try search.backlinks(noteId: noteId, order: order)
        }
    }

    func linksTo(targetId: String, order: BacklinkOrder) async throws -> [BacklinkRow] {
        let search = search
        return try await executor.run {
            try search.linksTo(targetId: targetId, order: order)
        }
    }

    func unlinkedMentions(targetId: String) async throws -> [UnlinkedMention] {
        let search = search
        return try await executor.run { try search.unlinkedMentions(targetId: targetId) }
    }
}

/// What the search field is showing.
@MainActor
@Observable
final class VaultSearchViewModel {
    enum Phase: Equatable {
        /// No query. **Not** an empty result: the list below is the vault.
        case idle
        case searching
        /// A query that matched nothing. A fact about the query, not a failure.
        case results([SearchResult])
        case failed(UserFacingError)
    }

    private(set) var phase: Phase = .idle
    /// The tasks the same query matched (TP056), shown in their own section.
    /// Empty while idle, searching or after a failure.
    private(set) var taskHits: [SearchResult] = []

    private let search: any VaultSearching
    /// How long a keystroke waits before it becomes a query.
    ///
    /// One FFI crossing and one FTS query per letter is work nobody asked
    /// for. Injectable so a test can set it to zero: a test that slept past a
    /// hardcoded debounce would be asserting about a timer, and would fail on
    /// a loaded machine for reasons that have nothing to do with search.
    private let debounce: Duration
    /// The in-flight query, cancelled when the next keystroke arrives so a
    /// slow search cannot land after a newer one and overwrite it.
    private var running: Task<Void, Never>?
    /// Which search box this is, as the `source` of `search_performed`.
    private let source: StaticString
    /// The vault's index owner, followed so a reindex re-runs the query.
    private let index: VaultSearchIndex?
    /// The trimmed query on screen, run again after each reindex.
    private var query = ""

    init(
        search: any VaultSearching,
        index: VaultSearchIndex? = nil,
        debounce: Duration = .milliseconds(150),
        source: StaticString = "global"
    ) {
        self.search = search
        self.index = index
        self.debounce = debounce
        self.source = source
        followIndex()
    }

    /// The last reindex failed: results may miss recent changes.
    var isIndexStale: Bool { index?.failure != nil }

    /// Retry for ``isIndexStale``. A success re-runs the query.
    func retryIndex() async {
        await index?.reindex()
    }

    /// Waits for the query in flight. For tests, which need the answer rather
    /// than a guess at how long it takes.
    func settle() async {
        await running?.value
    }

    /// Re-runs the query on screen after each finished reindex, for as long
    /// as this model lives. Registered synchronously, so no reindex finishing
    /// after `init` is missed.
    private func followIndex() {
        guard let index else { return }
        withObservationTracking {
            _ = index.completed
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.rerun()
                self?.followIndex()
            }
        }
    }

    /// The same query again, its results kept on screen until the new ones
    /// land.
    private func rerun() {
        guard !query.isEmpty else { return }
        running?.cancel()
        running = start(query, after: .zero, source: nil)
    }

    /// Runs `query`, replacing whatever was in flight.
    func run(_ query: String) {
        running?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.query = trimmed
        guard !trimmed.isEmpty else {
            phase = .idle
            taskHits = []
            return
        }
        // Desktop counts a search as opened once the user types into an
        // empty box (`command-palette.tsx`), not when the box appears.
        if phase == .idle {
            Telemetry.shared.track(.searchOpened, surface: .search, action: "opened")
        }
        phase = .searching
        running = start(trimmed, after: debounce, source: source)
    }

    /// One query. `source` is `nil` for a re-run after a reindex, which is not
    /// a search the user performed.
    private func start(_ trimmed: String, after debounce: Duration, source: StaticString?) -> Task<Void, Never> {
        Task { [search] in
            do {
                try await Task.sleep(for: debounce)
                let started = ContinuousClock.now
                let hits = try await search.notes(query: trimmed, limit: 50)
                let tasks = await taskMatches(trimmed)
                guard !Task.isCancelled else { return }
                Log.storage.info("searched this vault", .count(hits.count + tasks.count))
                if let source { Self.trackPerformed(source: source, count: hits.count + tasks.count, since: started) }
                taskHits = tasks
                phase = .results(hits)
            } catch is CancellationError {
                // A newer query owns the screen now.
            } catch {
                guard !Task.isCancelled else { return }
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("this vault could not be searched", .code(mapped.code))
                if let source {
                    Telemetry.shared.track(
                        .searchPerformed, surface: .search, action: "queried", source: source,
                        result: .failed, errorCode: mapped.code
                    )
                }
                taskHits = []
                phase = .failed(mapped)
            }
        }
    }

    /// Desktop `search-handlers.ts`: the count, the time and a coarse bucket,
    /// never the query.
    private static func trackPerformed(source: StaticString, count: Int, since started: ContinuousClock.Instant) {
        let elapsed = (ContinuousClock.now - started) / .milliseconds(1)
        let bucket = count == 0 ? "zero" : count <= 5 ? "one_to_five" : "six_plus"
        Telemetry.shared.track(
            .searchPerformed, surface: .search, action: "queried", source: source, result: .success,
            dimension: (.resultBucket, bucket),
            metrics: TelemetryMetrics(durationMs: elapsed.rounded(), resultCount: Double(count))
        )
    }

    /// The task half of a query. A failure here is logged and reads as no
    /// task matches: the note results still answer the query, and replacing
    /// them with an error would hide what the index did find.
    private func taskMatches(_ query: String) async -> [SearchResult] {
        do {
            return try await search.tasks(query: query, limit: 20)
        } catch is CancellationError {
            return []
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this vault's tasks could not be searched", .code(mapped.code))
            return []
        }
    }
}
