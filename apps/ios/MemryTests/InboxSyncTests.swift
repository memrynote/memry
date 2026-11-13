import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #4155: the Inbox syncs through the vault's one scheduler (the tasks store),
// re-reads after every pass whoever asked for it, and pull to refresh never
// waits on a pass queued behind a long pull.

/// The first pass holds until released; attachment redrives can be held too.
private final class GatedFiller: VaultFilling, @unchecked Sendable {
    private let started = Mutex(0)
    private let passGate = Mutex<CheckedContinuation<Void, Never>?>(nil)
    private let redriveGate = Mutex<CheckedContinuation<Void, Never>?>(nil)
    let holdFirstPass: Bool
    let holdRedrive: Bool

    init(holdFirstPass: Bool = false, holdRedrive: Bool = false) {
        self.holdFirstPass = holdFirstPass
        self.holdRedrive = holdRedrive
    }

    var passes: Int { started.withLock { $0 } }
    var passHeld: Bool { passGate.withLock { $0 != nil } }
    var redriveHeld: Bool { redriveGate.withLock { $0 != nil } }

    func releasePass() { passGate.withLock { $0?.resume(); $0 = nil } }
    func releaseRedrive() { redriveGate.withLock { $0?.resume(); $0 = nil } }

    func syncNow() async throws -> SyncPassSummary {
        let first = started.withLock { count in
            count += 1
            return count == 1
        }
        if first, holdFirstPass {
            await withCheckedContinuation { continuation in passGate.withLock { $0 = continuation } }
        }
        return SyncPassSummary(pulled: 0, deleted: 0, bodies: 0, pushed: 0, rejected: 0, pending: 0)
    }

    func redriveAttachments(reachable: Reachable) async throws -> AttachmentRedriveSummary {
        if holdRedrive {
            await withCheckedContinuation { continuation in redriveGate.withLock { $0 = continuation } }
        }
        return AttachmentRedriveSummary(downloaded: 0, deferred: 0, failed: 0, remaining: 0)
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        throw SyncError.Locked
    }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        throw SyncError.Locked
    }
}

@MainActor
@Suite("Inbox sync scheduling", .serialized)
struct InboxSyncTests {
    /// The wiring `VaultInboxScope` makes: the inbox asks the tasks store.
    private func inbox(sharing tasks: TasksStore) throws -> InboxTestVault {
        let scratch = try InboxTestVault()
        scratch.store.requestSync = { tasks.scheduleSync() }
        return scratch
    }

    @Test func a_capture_made_mid_pass_gets_a_pass_after_it() async throws {
        let filler = GatedFiller(holdFirstPass: true)
        let tasks = try TasksTestVault(filler: filler)
        let scratch = try inbox(sharing: tasks.store)
        let running = Task { await tasks.store.sync() }
        try await wait { filler.passHeld }

        _ = await scratch.store.capture("[agent] SHIP-4155 mid-pass")
        // Past the 400 ms debounce, so the ask reached the running pass.
        try await Task.sleep(for: .milliseconds(600))
        #expect(filler.passes == 1)
        filler.releasePass()
        await running.value

        try await wait { filler.passes >= 2 }
        #expect(filler.passes == 2)
    }

    @Test func pull_to_refresh_returns_while_a_pass_is_still_running() async throws {
        let filler = GatedFiller(holdFirstPass: true)
        let tasks = try TasksTestVault(filler: filler)
        let scratch = try inbox(sharing: tasks.store)
        let running = Task { await tasks.store.sync() }
        try await wait { filler.passHeld }

        await scratch.store.sync()
        #expect(filler.passHeld, "the spinner ended before the pass did")

        filler.releasePass()
        await running.value
        try await wait { filler.passes >= 2 }
        #expect(filler.passes == 2, "the pull still got a pass of its own")
    }

    @Test func a_pass_another_screen_ran_shows_captures_it_brought() async throws {
        let scratch = try InboxTestVault()
        await scratch.store.load()
        #expect(scratch.store.items.isEmpty)

        // A row the pass applied: written to the vault, not through the store.
        _ = try scratch.inbox.captureText(
            content: "[agent] SHIP-4155 from desktop", title: nil, captureSource: nil, force: false
        )
        await scratch.store.syncPassFinished()
        #expect(scratch.store.items.count == 1)
    }
}

@MainActor
@Suite("Tasks store attachment redrive", .serialized)
struct TasksRedriveOutsidePassTests {
    @Test func a_slow_redrive_does_not_hold_the_next_pass() async throws {
        let filler = GatedFiller(holdRedrive: true)
        let tasks = try TasksTestVault(filler: filler)

        let first = Task { await tasks.store.sync() }
        try await wait { filler.redriveHeld }
        #expect(filler.redriveHeld)
        #expect(!tasks.store.isSyncing, "the pass is still open while attachments download")

        await tasks.store.sync()
        #expect(filler.passes == 2)
        filler.releaseRedrive()
        await first.value
    }
}
