import Foundation
import MemryCore
import os
import Testing

@testable import Memry

// T140. The executor's contract is four things, and each is testable: the work
// leaves the main thread, calls do not overlap, cancellation does what the
// doc comment says it does, and a core error crosses unrendered.
//
// The first one is the subtle one, and its first draft was wrong. It asserted
// only that the work left the main thread — and that assertion passed with the
// `queue.async` hop deleted, because a `nonisolated async` function today hops
// to the global concurrent executor rather than staying on the caller's actor.
// SE-0461 is what removes that accident, and the executor's guarantee was never
// "some other thread" anyway: it is "this serial queue". So the assertion names
// the queue, and the main-thread check is kept only as the weaker companion.
@Suite("CoreExecutor")
struct CoreExecutorTests {
    @MainActor
    @Test("work runs off the main thread and the result returns to the caller's actor")
    func hopsOffTheMainThreadAndBack() async throws {
        #expect(isMainThread())

        let label = "test.core-executor.hop"
        let executor = CoreExecutor(label: label)
        let observed = try await executor.run { (isMainThread(), currentQueueLabel()) }

        #expect(observed.0 == false)
        #expect(observed.1 == label)
        #expect(isMainThread())
    }

    @Test("calls never overlap: one serial queue fronts the core")
    func callsAreSerialised() async throws {
        let executor = CoreExecutor(label: "test.core-executor.serial")
        let tracker = ConcurrencyTracker()

        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0 ..< 16 {
                group.addTask {
                    try await executor.run {
                        tracker.enter()
                        // Long enough that genuinely concurrent blocks would
                        // be caught overlapping; short enough to stay cheap.
                        Thread.sleep(forTimeInterval: 0.002)
                        tracker.leave()
                    }
                }
            }
            try await group.waitForAll()
        }

        #expect(tracker.peak == 1)
        #expect(tracker.completed == 16)
    }

    @Test("a call cancelled while it waits its turn never enters the core")
    func cancellationBeforeStartSkipsTheWork() async throws {
        let executor = CoreExecutor(label: "test.core-executor.queued")
        let gate = DispatchSemaphore(value: 0)
        let blockerStarted = OSAllocatedUnfairLock(initialState: false)
        let victimRan = OSAllocatedUnfairLock(initialState: false)

        // Occupy the single queue, so the next submission has to wait its turn.
        let blocker = Task {
            try await executor.run {
                blockerStarted.withLock { $0 = true }
                gate.wait()
            }
        }
        await waitUntil { blockerStarted.withLock { $0 } }

        let victim = Task {
            try await executor.run { victimRan.withLock { $0 = true } }
        }
        // The queue is held, so the victim is parked behind the blocker. The
        // pause is only to let it get that far; if it has not, the
        // `Task.checkCancellation()` arm produces the identical outcome.
        try await Task.sleep(for: .milliseconds(50))
        victim.cancel()

        // Release the queue *before* awaiting the victim. Its block is parked
        // behind the blocker, and the continuation is resumed by that block, so
        // awaiting first deadlocks the test against its own fixture. Draining
        // is what makes the victim's block run and decline the work, which is
        // the thing being asserted.
        gate.signal()
        try await blocker.value

        await #expect(throws: CancellationError.self) {
            try await victim.value
        }
        #expect(victimRan.withLock { $0 } == false)
    }

    @Test("a task already cancelled never reaches the queue at all")
    func cancellationBeforeSubmitSkipsTheQueue() async throws {
        let executor = CoreExecutor(label: "test.core-executor.early")
        let didRun = OSAllocatedUnfairLock(initialState: false)

        let task = Task {
            // Cancelling makes this return immediately, so `run` is reached
            // with the task already cancelled however the timing falls.
            try? await Task.sleep(for: .seconds(60))
            return try await executor.run { didRun.withLock { $0 = true } }
        }
        try await Task.sleep(for: .milliseconds(20))
        task.cancel()

        await #expect(throws: CancellationError.self) {
            try await task.value
        }
        #expect(didRun.withLock { $0 } == false)
    }

    @Test("cancellation after the work starts still delivers the core's answer")
    func cancellationAfterStartStillDelivers() async throws {
        let executor = CoreExecutor(label: "test.core-executor.inflight")
        let started = OSAllocatedUnfairLock(initialState: false)

        let task = Task {
            try await executor.run { () -> Int in
                started.withLock { $0 = true }
                // Stands in for a blocking core call that cannot be
                // interrupted once libsodium or SQLite has it.
                Thread.sleep(forTimeInterval: 0.15)
                return 42
            }
        }
        await waitUntil { started.withLock { $0 } }
        task.cancel()

        let value = try await task.value
        #expect(value == 42)
    }

    @Test("a core error crosses as its own typed value, unrendered")
    func coreErrorsCrossUnrendered() async throws {
        let executor = CoreExecutor(label: "test.core-executor.errors")

        // Nothing here turns this into a sentence: T142 owns that
        // (Constitution II). The executor's job is to leave it a value.
        await #expect(throws: RecoveryError.self) {
            try await executor.run {
                try validateRecoveryPhrase(phrase: "not a real recovery phrase")
            }
        }
    }

    @Test("a real core call round-trips its value through the executor")
    func realCoreCallRoundTrips() async throws {
        let executor = CoreExecutor(label: "test.core-executor.version")
        let version = try await executor.run { coreVersion() }

        #expect(version.isEmpty == false)
    }

    /// Polls a flag the queue thread sets. A fixed sleep here would be either
    /// flaky or slow, and both of those read as the executor's fault later.
    private func waitUntil(
        _ condition: @Sendable () -> Bool,
        timeout: Duration = .seconds(5),
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("condition never became true within \(timeout)", sourceLocation: sourceLocation)
    }
}

/// `Thread.isMainThread` is unavailable from an asynchronous context — the
/// compiler rejects it outright — so the check goes one layer down to the
/// pthread the work is actually running on.
private func isMainThread() -> Bool {
    pthread_main_np() != 0
}

/// The label of the dispatch queue the calling code is on, or the empty-ish
/// label of the global concurrent queue when it is on no named queue.
///
/// This is the assertion that actually pins the executor's mechanism. Deleting
/// the `queue.async` hop leaves the work off the main thread all the same, so
/// an `isMainThread()` check alone agrees with the bug; comparing the label to
/// the one this test constructed does not.
private func currentQueueLabel() -> String {
    String(cString: __dispatch_queue_get_label(nil))
}

/// Counts how many blocks are inside the executor at once.
///
/// `peak` is the assertion that matters: a serial queue can never let it past
/// one, and a concurrent queue reaches sixteen almost immediately.
private struct ConcurrencyTracker: Sendable {
    private struct Counts {
        var live = 0
        var peak = 0
        var completed = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: Counts())

    func enter() {
        state.withLock {
            $0.live += 1
            $0.peak = max($0.peak, $0.live)
        }
    }

    func leave() {
        state.withLock {
            $0.live -= 1
            $0.completed += 1
        }
    }

    var peak: Int { state.withLock { $0.peak } }
    var completed: Int { state.withLock { $0.completed } }
}
