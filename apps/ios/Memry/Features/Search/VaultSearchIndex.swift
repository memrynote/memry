import MemryCore
import Observation
import SwiftUI

// The one owner of "is this vault's search index up to date" (#4324).
//
// **Why one owner.** Search, backlinks, link targets and unlinked mentions all
// read `index.db`, and each screen used to reindex on its own schedule: the
// search sheet once when it opened, the journal after a pass, a note's
// backlinks once. A sync landing while the search sheet was open stayed
// invisible until the sheet was reopened, a failed reindex only reached the
// log, and two `Search` handles reindexing at once can meet SQLite busy.
//
// Now the vault scope asks this owner after every sync pass and every local
// write. It debounces, runs one reindex at a time, and publishes each finished
// reindex (`completed`) and the last failure. Screens re-read when `completed`
// moves instead of reindexing themselves.

@MainActor
@Observable
final class VaultSearchIndex {
    /// Reindexes that brought the index up to date. A screen reading the index
    /// re-reads when this moves.
    private(set) var completed = 0
    /// Why the last reindex failed, `nil` once one succeeds. The index still
    /// answers, from before the failure.
    private(set) var failure: UserFacingError?

    private let search: any VaultSearching
    /// How long a request waits for the next one. A sync pass and the writes
    /// around it come in bursts; one reindex covers the burst.
    private let debounce: Duration
    @ObservationIgnored private var scheduled: Task<Void, Never>?
    @ObservationIgnored private var running: Task<Void, Never>?
    /// A request arrived while a reindex ran, which may have walked past the
    /// change: run once more before finishing.
    @ObservationIgnored private var again = false

    /// A note body pull landed content outside a sync pass. The vault scope
    /// schedules a reindex on it.
    nonisolated static let bodyLanded = Notification.Name("memry.searchIndex.bodyLanded")

    init(search: any VaultSearching, debounce: Duration = .milliseconds(300)) {
        self.search = search
        self.debounce = debounce
    }

    /// The index may be behind: reindex soon.
    func schedule() {
        scheduled?.cancel()
        scheduled = Task { [debounce] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            await reindex()
        }
    }

    /// Reindexes now, or once more after the reindex in flight, and returns
    /// when the index is up to date or has failed. Retry calls this.
    func reindex() async {
        if let running {
            again = true
            await running.value
            return
        }
        let task = Task { await drain() }
        running = task
        await task.value
    }

    /// Waits for a scheduled reindex and the one in flight. For tests.
    func settle() async {
        await scheduled?.value
        await running?.value
    }

    private func drain() async {
        var succeeded = false
        repeat {
            again = false
            do {
                try await search.reindex()
                succeeded = true
                failure = nil
            } catch {
                succeeded = false
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("the search index could not be brought up to date", .code(mapped.code))
                failure = mapped
            }
        } while again
        // In the same main-actor turn as the last check of `again`, so a
        // request arriving now starts a new reindex instead of joining this one.
        running = nil
        if succeeded { completed += 1 }
    }
}

extension EnvironmentValues {
    /// The opened vault's search index owner, `nil` when the index could not
    /// be opened or outside the vault shell.
    @Entry var vaultSearchIndex: VaultSearchIndex?
}
