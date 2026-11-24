import Foundation
import Synchronization

/// Waits until `condition` holds, or `timeout` seconds pass. The caller's
/// `#expect` after it reports a condition that never held.
@MainActor
func wait(_ timeout: TimeInterval = 3, until condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
}

/// Wakes the tests waiting on a fake when the fake's state changes, so a test
/// awaits the condition it asserts instead of polling it against a deadline.
///
/// A full parallel Unit run keeps the main actor and the shared core executor
/// busy for seconds at a time on a CI runner, so a short deadline measures the
/// runner, not the code (#5484). The bound is the test's `.timeLimit`: a
/// cancelled waiter is resumed, so an expiry fails the test instead of hanging.
final class Changes: Sendable {
    private let waiters = Mutex<[UUID: CheckedContinuation<Void, Never>]>([:])

    /// Call after every mutation a waiter may be watching.
    func changed() {
        let woken = waiters.withLock { waiters in
            defer { waiters.removeAll() }
            return Array(waiters.values)
        }
        for waiter in woken { waiter.resume() }
    }

    /// Returns once `condition` holds, or once the task is cancelled.
    func until(isolation: isolated (any Actor)? = #isolation, _ condition: () -> Bool) async {
        while !condition(), !Task.isCancelled {
            let id = UUID()
            await withTaskCancellationHandler {
                // Explicit: the operation closure does not inherit `isolation`
                // on every toolchain, and the body below calls the caller's
                // `condition`, which traps the host off its actor (#5484).
                await withCheckedContinuation(isolation: isolation) { continuation in
                    waiters.withLock { $0[id] = continuation }
                    // Checked again after registering: a change between the
                    // loop's check and the registration would wake nobody.
                    if condition() || Task.isCancelled { resume(id) }
                }
            } onCancel: {
                resume(id)
            }
        }
    }

    private func resume(_ id: UUID) {
        waiters.withLock { $0.removeValue(forKey: id) }?.resume()
    }
}
