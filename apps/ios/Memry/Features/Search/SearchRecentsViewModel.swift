import Foundation
import MemryCore
import Observation

// The search sheet's recently opened results (#4322), desktop's recent
// reasons. The core owns the rules (device-local in `data.db`, ten newest,
// one row per item, deleted items skipped); this is the shell's handle.
// The query that found an item is private, so it is never logged.

/// The recents surface over one vault.
protocol SearchRecentsStoring: Sendable {
    func record(_ result: SearchResult, query: String) async throws
    func list() async throws -> [SearchRecent]
    func clear() async throws
}

/// The production store: the core's `SearchRecents`, over the core queue.
struct CoreSearchRecents: SearchRecentsStoring {
    private let recents: SearchRecents
    private let executor: CoreExecutor

    init(vault: Vault, executor: CoreExecutor) {
        recents = vault.searchRecents()
        self.executor = executor
    }

    func record(_ result: SearchResult, query: String) async throws {
        let recents = recents
        try await executor.run { try recents.record(result: result, query: query) }
    }

    func list() async throws -> [SearchRecent] {
        let recents = recents
        return try await executor.run { try recents.list() }
    }

    func clear() async throws {
        let recents = recents
        try await executor.run { try recents.clear() }
    }
}

/// What the empty search sheet lists.
@MainActor
@Observable
final class SearchRecentsViewModel {
    private(set) var items: [SearchRecent] = []

    private let store: any SearchRecentsStoring

    init(store: any SearchRecentsStoring) {
        self.store = store
    }

    /// A failed read leaves the list as it was: recents are a shortcut, and
    /// the search box still works without them.
    func load() async {
        do {
            items = try await store.list()
        } catch {
            Log.storage.error("recent searches could not be read", .code(ErrorMapping.userFacing(error).code))
        }
    }

    /// Records that `hit` was opened from a search for `query`.
    func record(_ hit: SearchResult, query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await store.record(hit, query: trimmed)
        } catch {
            Log.storage.error("a recent search could not be saved", .code(ErrorMapping.userFacing(error).code))
        }
    }

    func clear() async {
        do {
            try await store.clear()
            items = []
        } catch {
            Log.storage.error("recent searches could not be cleared", .code(ErrorMapping.userFacing(error).code))
        }
    }
}
