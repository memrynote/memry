import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #2798: a realtime hint that lands while a pass is running must still get a
// pass. The running one may have pulled before the change the hint is about,
// and dropping the ask leaves the change waiting for some later local reason.

/// A pass that holds until released, counting how many started.
private final class HeldPasses: VaultFilling, @unchecked Sendable {
    private let started = Mutex(0)
    private let gate = Mutex<CheckedContinuation<Void, Never>?>(nil)

    var count: Int { started.withLock { $0 } }
    var held: Bool { gate.withLock { $0 != nil } }

    func release() {
        gate.withLock { $0?.resume(); $0 = nil }
    }

    func syncNow() async throws -> SyncPassSummary {
        let first = started.withLock { count in
            count += 1
            return count == 1
        }
        if first {
            await withCheckedContinuation { continuation in
                gate.withLock { $0 = continuation }
            }
        }
        return SyncPassSummary(pulled: 0, deleted: 0, bodies: 0, pushed: 0, rejected: 0, pending: 0)
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        throw SyncError.Locked
    }
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
        throw SyncError.Locked
    }
}

@MainActor
@Suite("Tasks store sync coalescing", .serialized)
struct TasksSyncAgainTests {
    @Test func an_ask_during_a_running_pass_runs_one_more_pass_after_it() async throws {
        let filler = HeldPasses()
        let vault = try TasksTestVault(filler: filler)
        let running = Task { await vault.store.sync() }
        while !filler.held { await Task.yield() }

        // The hint arrives mid-pass. It returns at once; it must not be lost.
        await vault.store.sync()
        filler.release()
        await running.value

        let deadline = Date().addingTimeInterval(3)
        while filler.count < 2, Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(filler.count == 2)
    }
}
