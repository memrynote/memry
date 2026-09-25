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
        /// TP056. No task hits: the task half of a query is asserted in
        /// `TasksNotesTests` against a real index.
        func tasks(query: String, limit: UInt32) async throws -> [SearchResult] { [] }

        let queries = Mutex([String]())
        let reindexes = Mutex(0)
        private let hits: [SearchResult]
        private let failure: (any Error)?
        private let reindexFailure: (any Error)?

        init(hits: [SearchResult] = [], failure: (any Error)? = nil, reindexFailure: (any Error)? = nil) {
            self.hits = hits
            self.failure = failure
            self.reindexFailure = reindexFailure
        }

        func notes(query: String, limit: UInt32) async throws -> [SearchResult] {
            queries.withLock { $0.append(query) }
            if let failure { throw failure }
            return hits
        }

        func reindex() async throws {
            reindexes.withLock { $0 += 1 }
            if let reindexFailure { throw reindexFailure }
        }
    }

    private func hit(_ id: String, _ title: String, kind: String = "note") -> SearchResult {
        SearchResult(id: id, title: title, kind: kind, journalDate: nil, score: -1)
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

    @Test("the index is brought up to date once, and a failed reindex is not shown")
    func prepareRunsOnce() async {
        // A stale index still answers; the queries that follow say so
        // themselves if they fail. Blocking the screen on it would make a
        // rebuild look like a broken vault.
        let search = ScriptedSearch(reindexFailure: StorageError.Failed(what: "no disk"))
        let model = model(search)

        await model.prepare()
        await model.prepare()

        #expect(search.reindexes.withLock { $0 } == 1)
        #expect(model.phase == .idle)
    }
}
