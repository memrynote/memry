import Foundation
import os

/// The shell's single path into the Rust core.
///
/// **Why a `DispatchQueue` and not an `actor`.** Every UniFFI object crosses as
/// `@unchecked Sendable` and the core already serialises its own state behind
/// interior mutability. A Swift `actor` in front of that is a second queue in
/// front of the first: every call pays two hops for one guarantee (research
/// R15). One serial queue, owned here, is the whole mechanism.
///
/// **Why the queue is the mechanism and not decoration.** `Task {}` inherits
/// the enclosing actor's isolation, and SE-0461 makes a `nonisolated async`
/// function run on the caller's actor. So marking a wrapper `async` does *not*
/// move a blocking call off the main thread — it runs it on the main actor and
/// freezes the UI for the length of an Argon2id derivation. `queue.async` is
/// what actually moves the work; `withCheckedThrowingContinuation` is only the
/// bridge that hands the answer back to Swift concurrency.
///
/// **What belongs here.** The core's exported free functions and the
/// synchronous methods on its objects. Every one of them blocks the calling
/// thread until Rust returns, which is exactly what must not happen on the main
/// thread. UniFFI's `async` methods — `AuthSession.refresh` and its siblings —
/// are the documented exception: they suspend rather than block, so there is no
/// thread to move them off, and forcing one through this queue would mean
/// parking a queue thread on a semaphore and stalling every other core call
/// behind a network round trip. Those are awaited directly.
///
/// **What must never happen here.** A Swift method that *Rust* calls — any of
/// the nine foreign-trait seams — must not re-enter the core
/// (`contracts/shell-seams.md`, §"There is no event seam"). UniFFI dispatches
/// those synchronously on the calling Rust thread while the core may hold a
/// lock, and when Rust called into Swift from inside a block already running on
/// this queue, a synchronous wait on `run` deadlocks the queue against itself.
/// A seam implementation does the platform thing and returns, or enqueues into
/// `CoreEvents` and returns.
///
/// **Errors cross as the core's own typed values and nothing here renders one.**
/// `ErrorMapping.swift` (T142) is the only place a user-facing string is made
/// from a core error (Constitution II).
public final class CoreExecutor: Sendable {
    /// The app's executor. One queue for the process, which is the point: a
    /// second instance is a second serial order and the core sees interleaving
    /// neither of them intended. Tests build their own so they do not share a
    /// backlog.
    public static let shared = CoreExecutor()

    private let queue: DispatchQueue

    public init(label: String = "com.memry.core-executor") {
        // `.userInitiated`: work on this queue is either a user action with a
        // screen waiting on it or a short periodic poll. Nothing here is
        // throughput work that should yield to the UI, and nothing here is
        // background enough to deserve `.utility`.
        queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    /// Runs `work` on the core queue and awaits its result.
    ///
    /// This is `throws` even for a core call that cannot fail, because
    /// cancellation can throw. One method rather than a throwing/non-throwing
    /// pair: the overload pair is ambiguous at almost every call site and buys
    /// only the removal of a `try` that is honest anyway.
    ///
    /// **Cancellation.** `withCheckedThrowingContinuation` is not cancellable,
    /// and a blocking core call cannot be interrupted mid-flight — Rust is
    /// inside libsodium or SQLite and there is nothing to poll. The policy is
    /// therefore the only implementable one, and it is stated rather than
    /// implied:
    ///
    /// - Cancelled **before the work starts**, including while it waits its
    ///   turn behind another call: it never runs, `run` throws
    ///   `CancellationError`, and the core is never entered. This is the case
    ///   that earns its keep — a serial queue with a backlog is exactly where a
    ///   view that has gone away leaves work nobody wants.
    /// - Cancelled **after the work starts**: it runs to completion and its
    ///   result is delivered normally. Resuming early would leave the call in
    ///   flight with nobody holding it and throw away an answer the core has
    ///   already paid for.
    ///
    /// Research R15 does not settle this; it is decided here, and
    /// `CoreExecutorTests` pins both halves.
    public func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let ticket = Ticket()
        return try await withTaskCancellationHandler {
            // The cheap arm of the same policy: a task already cancelled when
            // it reached us is not enqueued at all.
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    guard ticket.claim() else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    do {
                        let value = try work()
                        continuation.resume(returning: value)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            ticket.cancel()
        }
    }
}

/// One bit, shared between the cancellation handler and the queued block.
///
/// `claim()` is the instant the work stops being cancellable: whoever reaches
/// the lock first decides, so a later `cancel()` is a no-op by construction
/// rather than by timing. Copies share the allocation, which is what lets the
/// `onCancel` closure and the queued block see the same bit.
private struct Ticket: Sendable {
    private let cancelled = OSAllocatedUnfairLock(initialState: false)

    func cancel() {
        cancelled.withLock { $0 = true }
    }

    /// `true` when the work may proceed, `false` when it was cancelled first.
    func claim() -> Bool {
        cancelled.withLock { !$0 }
    }
}
