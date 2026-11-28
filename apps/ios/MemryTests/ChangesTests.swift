import Foundation
import Synchronization
import Testing

// #5484: `Changes.until` checked a main-actor test's condition on a dispatch
// worker, which traps the whole Unit host when the condition reads main-actor
// state. Every check runs where the caller runs.

@MainActor
@Suite("Changes waiter", .timeLimit(.minutes(1)))
struct ChangesTests {
    @Test("every check of the condition runs on the caller's actor")
    func everyCheckRunsOnTheCallersActor() async {
        let changes = Changes()
        let onMain = Mutex<[Bool]>([])
        // Sendable, so the closure itself is not main-actor isolated and
        // records the thread instead of trapping. The second check is the
        // re-check after the waiter registers, the one that ran off the actor.
        await changes.until { @Sendable in
            onMain.withLock { calls in
                calls.append(Thread.isMainThread)
                return calls.count >= 2
            }
        }
        let calls = onMain.withLock { $0 }
        #expect(calls.count >= 2)
        #expect(calls.allSatisfy { $0 }, "a check ran off the main thread: \(calls)")
    }
}
