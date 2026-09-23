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
// **Typing does not reindex.** A reindex walks what changed since the last
// watermark, so it belongs on an explicit moment — the screen appearing — and
// never inside a query.
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
    /// Brings the index up to date. Idempotent, and safe on any schedule.
    func reindex() async throws
    /// Every note linking to this one (N800).
    func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink]
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
    private var hasIndexed = false

    init(search: any VaultSearching, debounce: Duration = .milliseconds(150)) {
        self.search = search
        self.debounce = debounce
    }

    /// Waits for the query in flight. For tests, which need the answer rather
    /// than a guess at how long it takes.
    func settle() async {
        await running?.value
    }

    /// Brings the index up to date, once per screen.
    ///
    /// Before the first query rather than during it: an index that has never
    /// been built answers nothing, and a user typing into a box that silently
    /// returns nothing has no way to tell that from an empty vault.
    func prepare() async {
        guard !hasIndexed else { return }
        hasIndexed = true
        do {
            try await search.reindex()
        } catch {
            // Not surfaced. A stale index still answers, and the queries that
            // follow will say so themselves if they fail.
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("the search index could not be brought up to date", .code(mapped.code))
        }
    }

    /// Runs `query`, replacing whatever was in flight.
    func run(_ query: String) {
        running?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            phase = .idle
            return
        }
        phase = .searching
        running = Task { [search, debounce] in
            do {
                try await Task.sleep(for: debounce)
                let hits = try await search.notes(query: trimmed, limit: 50)
                guard !Task.isCancelled else { return }
                Log.storage.info("searched this vault", .count(hits.count))
                phase = .results(hits)
            } catch is CancellationError {
                // A newer query owns the screen now.
            } catch {
                guard !Task.isCancelled else { return }
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("this vault could not be searched", .code(mapped.code))
                phase = .failed(mapped)
            }
        }
    }
}
