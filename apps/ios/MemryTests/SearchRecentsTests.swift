import Foundation
import MemryCore
import Testing

@testable import Memry

// The search sheet's recents (#4322) over a real scratch vault and the core's
// `SearchRecents`, so the cap, dedupe and liveness asserted here are the
// core's own rather than a fake's.

@MainActor
@Suite("Search recents")
struct SearchRecentsTests {
    private let vault: TasksTestVault
    private let project: String
    private let model: SearchRecentsViewModel

    init() throws {
        vault = try TasksTestVault()
        project = try vault.project()
        model = SearchRecentsViewModel(
            store: CoreSearchRecents(vault: vault.vault, executor: CoreExecutor(label: "search-recents-tests"))
        )
    }

    private func hit(_ title: String) throws -> SearchResult {
        let id = try vault.task(title, project: project)
        return SearchResult(id: id, title: title, kind: "task", journalDate: nil, score: -1)
    }

    private var listed: [String] {
        model.items.map { "\($0.result.title)|\($0.query)" }
    }

    @Test func anOpenedHitIsListedWithTheQueryThatFoundIt() async throws {
        let first = try hit("Pay rent")
        await model.record(first, query: "  rent ")
        await model.load()
        #expect(listed == ["Pay rent|rent"])
        #expect(model.items.first?.result.kind == "task")
        #expect(model.items.first?.result.id == first.id)
    }

    @Test func reopeningAnItemListsItOnceWithTheNewerQuery() async throws {
        let rent = try hit("Pay rent")
        let call = try hit("Call mom")
        await model.record(rent, query: "rent")
        await model.record(call, query: "mom")
        await model.record(rent, query: "pay")
        await model.load()
        #expect(listed == ["Pay rent|pay", "Call mom|mom"])
    }

    @Test func onlyTheTenNewestAreKept() async throws {
        for index in 0 ..< 12 {
            await model.record(try hit("Task \(index)"), query: "q")
            }
        await model.load()
        #expect(model.items.map(\.result.title) == (2 ..< 12).reversed().map { "Task \($0)" })
    }

    @Test func clearEmptiesTheList() async throws {
        await model.record(try hit("Pay rent"), query: "rent")
        await model.load()
        await model.clear()
        #expect(model.items.isEmpty)
        await model.load()
        #expect(model.items.isEmpty)
    }

    @Test func anItemDeletedSinceItWasOpenedIsSkipped() async throws {
        let kept = try hit("Pay rent")
        let gone = try hit("Call mom")
        await model.record(kept, query: "rent")
        await model.record(gone, query: "mom")
        await vault.store.perform(nil) { try $0.delete(id: gone.id, promoteSubtasks: false) }
        await model.load()
        #expect(listed == ["Pay rent|rent"])
    }
}
