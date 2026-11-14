import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// The search field's state machine.
//
// What the Rust suite cannot see: which of the four answers ends up on screen.
// "Nothing matched" and "the index failed" are one keystroke apart and must
// never render as each other.

@MainActor
@Suite("Vault search")
struct VaultSearchTests {
    private final class ScriptedSearch: VaultSearching, @unchecked Sendable {
        /// N800. Empty rather than scripted: the backlink query is asserted
        /// in Rust against a real index, and a fake answering with rows would
        /// claim links this vault does not hold.
        func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink] { [] }
        func linksTo(targetId: String, order: BacklinkOrder) async throws -> [BacklinkRow] { [] }
        func unlinkedMentions(targetId: String) async throws -> [UnlinkedMention] { [] }

        let queries = Mutex([String]())
        let filters = Mutex([SearchFilter?]())
        let reindexes = Mutex(0)
        private let hits: [SearchResult]
        private let failure: (any Error)?
        let reindexFailure: Mutex<(any Error)?>
        /// Answers `semanticPending` without `semanticHits` until
        /// `semanticModelLoaded` returns, and for good when the load fails.
        private let modelLoading: Mutex<Bool>
        private let loadFails: Bool
        private let semanticHits: [SearchResult]
        let loadWaits = Mutex(0)
        /// Holds `semanticModelLoaded` until it yields, when set.
        private let loadGate: AsyncStream<Void>?

        init(
            hits: [SearchResult] = [], failure: (any Error)? = nil, reindexFailure: (any Error)? = nil,
            semanticHits: [SearchResult] = [], modelLoading: Bool = false, loadFails: Bool = false,
            loadGate: AsyncStream<Void>? = nil
        ) {
            self.hits = hits
            self.failure = failure
            self.reindexFailure = Mutex(reindexFailure)
            self.semanticHits = semanticHits
            self.modelLoading = Mutex(modelLoading)
            self.loadFails = loadFails
            self.loadGate = loadGate
        }

        /// Note hits only: the task and inbox groups are asserted against a
        /// real index in `TasksNotesTests` and `SearchInboxTests`.
        func search(query: String, filter: SearchFilter?, limit: UInt32) async throws -> SearchGroups {
            queries.withLock { $0.append(query) }
            filters.withLock { $0.append(filter) }
            if let failure { throw failure }
            let pending = modelLoading.withLock { $0 }
            return SearchGroups(
                notes: pending ? hits : hits + semanticHits, journals: [], tasks: [], inbox: [], semanticPending: pending
            )
        }

        func semanticModelLoaded() async -> Bool {
            loadWaits.withLock { $0 += 1 }
            if let loadGate { for await _ in loadGate { break } }
            if !loadFails { modelLoading.withLock { $0 = false } }
            return !loadFails
        }

        func reindex() async throws {
            reindexes.withLock { $0 += 1 }
            if let failure = reindexFailure.withLock({ $0 }) { throw failure }
        }
    }

    private func hit(_ id: String, _ title: String, kind: String = "note") -> SearchResult {
        SearchResult(id: id, title: title, kind: kind, journalDate: nil, emoji: nil, folderPath: nil, score: -1, snippet: [], matchKind: .body, matchedName: nil)
    }

    /// A model with no debounce, so a test waits for the work rather than for
    /// a clock.
    private func model(_ search: ScriptedSearch) -> VaultSearchViewModel {
        VaultSearchViewModel(search: search, debounce: .zero)
    }

    @Test("an empty query is idle, not an empty result")
    func emptyQueryIsIdle() async {
        // The list below the field is the whole vault at that moment; showing
        // "no results" over it would be a lie about what is there.
        let search = ScriptedSearch(hits: [hit("n1", "Dune")])
        let model = model(search)

        model.run("   ")
        await model.settle()

        #expect(model.phase == .idle)
        #expect(search.queries.withLock { $0 }.isEmpty, "a blank query must not reach the index")
    }

    @Test("a query that matches nothing is a result, not a failure")
    func noMatchesIsAResult() async {
        let model = model(ScriptedSearch(hits: []))

        model.run("cardamom")
        await model.settle()

        #expect(model.phase == .results([]))
    }

    @Test("a failed search is a failure, never an empty result")
    func aFailedSearchIsAFailure() async {
        let model = model(ScriptedSearch(failure: StorageError.Failed(what: "the index is locked")))

        model.run("cardamom")
        await model.settle()

        guard case .failed = model.phase else {
            Issue.record("expected a failure, got \(model.phase)")
            return
        }
    }

    @Test("a newer query replaces the one in flight")
    func laterQueryWins() async {
        // Without cancellation a slow first search lands after a newer one and
        // puts stale hits under a newer word.
        let search = ScriptedSearch(hits: [hit("n1", "Dune")])
        let model = model(search)

        model.run("du")
        model.run("dune")
        await model.settle()

        #expect(search.queries.withLock { $0 } == ["dune"], "the debounced first query never ran")
        #expect(model.phase == .results([hit("n1", "Dune")]))
    }

    @Test("a query typed while the model loads runs once more when the load lands")
    func pendingQueryRerunsAfterTheLoad() async {
        // #4615: the cold query answered "No Results" and stayed that way until
        // the next keystroke.
        let search = ScriptedSearch(semanticHits: [hit("n1", "Saturday afternoon")], modelLoading: true)
        let model = model(search)

        model.run("puppy playing")
        await model.settle()

        #expect(search.queries.withLock { $0 } == ["puppy playing", "puppy playing"])
        #expect(search.loadWaits.withLock { $0 } == 1)
        #expect(model.phase == .results([hit("n1", "Saturday afternoon")]))
    }

    @Test("a load that fails or a memory warning overtook runs nothing again")
    func failedLoadDoesNotRerun() async {
        // REVIEW-4621: a re-run after a released load would start a fresh
        // model load and undo the memory warning.
        let search = ScriptedSearch(hits: [hit("n1", "Dune")], modelLoading: true, loadFails: true)
        let model = model(search)

        model.run("dune")
        await model.settle()

        #expect(search.queries.withLock { $0 } == ["dune"])
        #expect(search.loadWaits.withLock { $0 } == 1)
        #expect(model.phase == .results([hit("n1", "Dune")]))
    }

    @Test("a filter change runs the query on screen again with the scope and menu filters")
    func filtersReachTheSearch() async {
        let search = ScriptedSearch(hits: [hit("n1", "Dune")])
        let model = model(search)
        model.run("dune")
        await model.settle()

        var filters = model.filters
        filters.scope = .journal
        filters.toggle(tag: "searchtest")
        model.apply(filters)
        await model.settle()

        #expect(search.queries.withLock { $0 } == ["dune", "dune"])
        #expect(search.filters.withLock { $0 } == [nil, SearchFilter(types: [.journal], modified: nil, tags: ["searchtest"])])
        #expect(model.phase == .results([hit("n1", "Dune")]))
    }

    @Test("a burst of sync passes reindexes once, and the followed screen runs the query on it again")
    func syncPassesReindexAndRequery() async throws {
        // #4324: a sync landing while the sheet is open used to stay invisible
        // until the sheet was reopened. The sheet's `.task` follows the index.
        let search = ScriptedSearch(hits: [hit("n1", "Dune")])
        let index = VaultSearchIndex(search: search, debounce: .zero)
        let model = VaultSearchViewModel(search: search, index: index, debounce: .zero)
        model.run("dune")
        await model.settle()
        let follower = Task { await model.followIndex() }

        index.schedule()
        index.schedule()
        index.schedule()
        await index.settle()
        #expect(index.completed == 1)
        try await wait { search.queries.withLock { $0.count } >= 2 }
        await model.settle()

        #expect(search.reindexes.withLock { $0 } == 1, "the burst is debounced into one reindex")
        #expect(search.queries.withLock { $0 } == ["dune", "dune"], "the screen re-ran the query")
        #expect(model.phase == .results([hit("n1", "Dune")]))
        #expect(!model.isIndexStale)

        // The sheet went: its task is cancelled and the model stops following.
        follower.cancel()
        await follower.value
        index.schedule()
        await index.settle()
        for _ in 0 ..< 20 { await Task.yield() }
        #expect(index.completed == 2)
        #expect(search.queries.withLock { $0 }.count == 2, "a cancelled follower re-runs nothing")
    }

    @Test("a sheet dismissed while the model loads runs nothing when the load lands")
    func aDismissedSheetDropsItsPendingRerun() async throws {
        let (gate, open) = AsyncStream.makeStream(of: Void.self)
        let search = ScriptedSearch(semanticHits: [hit("n1", "Dune")], modelLoading: true, loadGate: gate)
        let index = VaultSearchIndex(search: search, debounce: .zero)
        let model = VaultSearchViewModel(search: search, index: index, debounce: .zero)
        let follower = Task { await model.followIndex() }
        model.run("dune")
        try await wait { search.loadWaits.withLock { $0 } == 1 }

        follower.cancel()
        await follower.value
        open.yield()
        await model.settle()

        #expect(search.queries.withLock { $0 } == ["dune"], "nobody sees the sheet")
    }

    @Test("a model whose sheet is gone runs no query when a reindex finishes")
    func aDismissedModelStaysQuiet() async {
        // SwiftUI keeps a dismissed sheet's toolbar, and with it the model,
        // alive. A model that followed the index itself re-ran its last query
        // on every sync pass for each sheet opened since launch.
        let search = ScriptedSearch(hits: [hit("n1", "Dune")])
        let index = VaultSearchIndex(search: search, debounce: .zero)
        let model = VaultSearchViewModel(search: search, index: index, debounce: .zero)
        model.run("dune")
        await model.settle()

        index.schedule()
        await index.settle()
        for _ in 0..<10 { await Task.yield() }
        await model.settle()

        #expect(search.reindexes.withLock { $0 } == 1)
        #expect(search.queries.withLock { $0 } == ["dune"], "only the screen re-runs a query")
    }

    @Test("a failed reindex says search may be out of date, and Retry clears it")
    func failedReindexShowsNoticeUntilRetry() async {
        let search = ScriptedSearch(hits: [hit("n1", "Dune")], reindexFailure: StorageError.Failed(what: "no disk"))
        let index = VaultSearchIndex(search: search, debounce: .zero)
        let model = VaultSearchViewModel(search: search, index: index, debounce: .zero)
        model.run("dune")
        await model.settle()

        index.schedule()
        await index.settle()

        #expect(model.isIndexStale)
        #expect(model.phase == .results([hit("n1", "Dune")]), "the stale index still answers")
        #expect(search.queries.withLock { $0 } == ["dune"], "a failed reindex re-runs nothing")

        search.reindexFailure.withLock { $0 = nil }
        await model.retryIndex()

        #expect(!model.isIndexStale)
        #expect(search.reindexes.withLock { $0 } == 2)
        #expect(index.completed == 1, "the screen re-runs the query when this moves")
    }
}
