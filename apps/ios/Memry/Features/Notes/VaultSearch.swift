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
// reindexes after sync passes and writes; the screen showing the box runs the
// query again (`rerun()`) each time it finishes. The screen subscribes, not
// this model: SwiftUI can keep a dismissed sheet's model alive, and a model
// that followed the index itself kept querying for a sheet nobody sees.
//
// **Semantic hits fuse in the core.** With semantic search on, the core folds
// notes near the query's meaning into the notes and journals groups (#4505).
// The first query after launch starts the model load and answers from FTS.
//
// **Results are the core's ranking, never re-sorted.** The order is what
// the query returned; a shell that sorted by date would be answering a
// different question than the one the user asked.

/// The search surface over one vault.
protocol VaultSearching: Sendable {
    /// Notes, journals, tasks and inbox captures matching `query`, each group
    /// best first and ranked on its own, narrowed by `filter` (#4321). A query
    /// carrying no searchable term returns **empty** — an empty box is not a
    /// request for the whole vault.
    func search(query: String, filter: SearchFilter?, limit: UInt32) async throws -> SearchGroups
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
    init(vault: Vault, executor: CoreExecutor, semantic: SemanticSearch? = nil) throws {
        search = try vault.search(semantic: semantic)
        self.executor = executor
    }

    func search(query: String, filter: SearchFilter?, limit: UInt32) async throws -> SearchGroups {
        let search = search
        return try await executor.run { try search.search(query: query, filter: filter, limit: limit) }
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

    /// The notes, then the journal days, the query matched.
    private(set) var phase: Phase = .idle
    /// The tasks the same query matched (TP056), shown in their own section.
    /// Empty while idle, searching or after a failure.
    private(set) var taskHits: [SearchResult] = []
    /// The inbox captures the same query matched (#4320), in their own
    /// section after the tasks. Empty whenever ``taskHits`` is.
    private(set) var inboxHits: [SearchResult] = []
    /// The scope and the filter menu's choices (#4321). A change runs the
    /// query on screen again.
    private(set) var filters = SearchFilters()

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
    /// The vault's index owner, read for its last failure.
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
    }

    /// The last reindex failed: results may miss recent changes.
    var isIndexStale: Bool { index?.failure != nil }

    /// Retry for ``isIndexStale``.
    func retryIndex() async {
        await index?.reindex()
    }

    /// Waits for the query in flight. For tests, which need the answer rather
    /// than a guess at how long it takes.
    func settle() async {
        await running?.value
    }

    /// Runs the query on screen again each time the index catches up, until
    /// the calling task is cancelled. The sheet runs it in its `.task`, so it
    /// stops when the sheet goes: SwiftUI keeps a dismissed sheet's model
    /// alive, and a model that followed the index on its own would re-run a
    /// query nobody sees on every sync pass.
    func followIndex() async {
        guard let index else { return }
        var seen = index.completed
        for await completed in Observations({ index.completed }) where completed != seen {
            seen = completed
            rerun()
        }
    }

    /// The same query again, its results kept on screen until the new ones
    /// land.
    func rerun() {
        guard !query.isEmpty else { return }
        running?.cancel()
        running = start(query, after: .zero, source: nil)
    }

    /// Narrows the query on screen to `filters`, without the typing debounce.
    func apply(_ filters: SearchFilters) {
        guard filters != self.filters else { return }
        self.filters = filters
        guard !query.isEmpty else { return }
        running?.cancel()
        phase = .searching
        running = start(query, after: .zero, source: source)
    }

    /// Runs `query`, replacing whatever was in flight.
    func run(_ query: String) {
        running?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.query = trimmed
        guard !trimmed.isEmpty else {
            phase = .idle
            taskHits = []
            inboxHits = []
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
        let filter = filters.record(now: .now, calendar: .current)
        return Task { [search] in
            do {
                try await Task.sleep(for: debounce)
                let started = ContinuousClock.now
                let groups = try await search.search(query: trimmed, filter: filter, limit: 50)
                guard !Task.isCancelled else { return }
                let hits = groups.notes + groups.journals
                let count = hits.count + groups.tasks.count + groups.inbox.count
                Log.storage.info("searched this vault", .count(count))
                if let source { Self.trackPerformed(source: source, count: count, since: started) }
                taskHits = groups.tasks
                inboxHits = groups.inbox
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
                inboxHits = []
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
}
