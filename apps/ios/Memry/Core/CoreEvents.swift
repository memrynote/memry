import Foundation
import Synchronization

// The shell's single event hub (T141, `contracts/shell-seams.md` §"There is no
// event seam").
//
// **There is no core-to-shell event trait and there must not be one.** The core
// exports twelve foreign traits: nine are implemented in Swift and called from
// Rust (the eight seams plus `SocketHandle`), three are implemented in Rust and
// called from Swift (`LifecycleObserver`, `ReachabilityObserver`,
// `SocketListener`). Every one of the nine is request-shaped — the core asks,
// the shell answers — so none of them is a channel the core can push UI news
// down. The eight-seam list is closed; a ninth needs a written justification in
// the specification (spec-defect 89).
//
// What replaces the missing trait is a rule, and it is absolute:
//
//     A Swift method that Rust calls MUST NOT re-enter the core.
//
// UniFFI dispatches a foreign-trait method synchronously on the calling Rust
// thread, and the core may hold the document registry's lock or the
// connection's at the call site. A Swift implementation that answers by calling
// back into the core deadlocks against a lock its own caller holds — only under
// the interleaving that produced the callback, which is exactly why such a bug
// survives a test suite. A seam implementation's whole job is to do the
// platform thing and return, or to enqueue here and return.

/// One hint that something changed. **Never a state delta.**
///
/// The buffer below is lossy on purpose, and that is only sound because every
/// element is a hint: the UI re-reads a snapshot through the core executor
/// rather than reconstructing state from the stream, so a dropped element costs
/// nothing while an unbounded buffer costs memory on a device already under
/// pressure. A stream whose elements were deltas could not be lossy.
///
/// That property is held by the type rather than by a comment: an event is a
/// ``Topic`` plus a ``Scope``, and a ``Scope`` carries at most an identifier, so
/// there is nowhere to put a value the UI could not obtain any other way. A
/// producer that wants to send state finds it cannot express one.
struct CoreEvent: Sendable, Equatable, Hashable {
    /// What changed. Each case names the task that owns its producer; nothing
    /// here is speculative, and a topic with no named producer does not belong.
    enum Topic: Sendable, Equatable, Hashable {
        /// T143 `Keychain`: a read returned `errSecInteractionNotAllowed`, so
        /// the entry is present but unreadable until first unlock. The event
        /// carries no reason string — T142's `ErrorMapping` renders copy, and
        /// Constitution II forbids showing a raw error object.
        case secureStoreLocked

        /// T144 `FileProtection`: a data-protection class was re-asserted on
        /// the `-wal`/`-shm` sidecars after first open, or free space moved.
        /// Both happen on the shell's own schedule, outside any core call.
        case storage

        /// T145 `Transport`: the realtime socket opened or closed, or a frame
        /// arrived. **Never the frame.** The socket is not a data path
        /// (chapter 09): a message is a hint that causes a pull, and the bytes
        /// belong to `SocketListener`, which is the core's.
        case realtimeSocket

        /// T146 `Reachability`: the `NWPathMonitor` path changed. Yielded
        /// *after* the transition has been handed to the core's
        /// `ReachabilityObserver`, which is a Swift-to-Rust call and therefore
        /// allowed; this event only tells the UI to re-read.
        case reachability

        /// T146 `CodeCapture`: camera authorization resolved to a new state.
        case capturePermission

        /// The shell's own source: `MemryApp`'s scene phase, the same
        /// transition that drives `LifecycleObserver`.
        case scenePhase
    }

    /// What the hint is about. An identifier is not state, which is why this is
    /// the only payload an event may carry.
    ///
    /// `document` exists because chapter §7.15's runtime obligation —
    /// `PullReport.purged_documents` and `BodyPullReport.advanced_documents`
    /// name ids that a registry holder must act on — is exactly the shape of
    /// thing that will one day arrive here. Nothing produces it yet, and wiring
    /// it is not this task.
    enum Scope: Sendable, Equatable, Hashable {
        case app
        case vault(String)
        case document(String)
    }

    let topic: Topic
    let scope: Scope

    init(_ topic: Topic, scope: Scope = .app) {
        self.topic = topic
        self.scope = scope
    }
}

/// The only thing a producer is handed.
///
/// This type is the enforcement of the re-entrancy rule. ``emit(_:)`` is
/// synchronous, non-throwing, returns `Void`, and is the emitter's entire
/// surface — so a seam implementation holding one cannot await a core answer,
/// cannot read anything back, and has nothing to block on. "Yield and return"
/// is not a convention here; it is the only thing the API permits.
///
/// Construct seams with an emitter, never with the hub and never with the core
/// executor. A seam that holds the executor can call the core, and the deadlock
/// above is then one line away.
struct CoreEventEmitter: Sendable {
    private let sink: @Sendable (CoreEvent) -> Void

    init(sink: @escaping @Sendable (CoreEvent) -> Void) {
        self.sink = sink
    }

    /// Enqueues a hint. Safe from any thread, including a Rust-owned one
    /// holding a core lock.
    ///
    /// Deliberately returns nothing: whether the buffer dropped an older
    /// element is not a producer's business, and a producer that branched on it
    /// would be treating hints as deltas.
    func emit(_ event: CoreEvent) {
        sink(event)
    }
}

/// The single path from anything asynchronous to SwiftUI.
///
/// **Single consumer, by decision and by construction.** An `AsyncStream` is
/// single-consumer anyway — two `for await` loops over one stream split its
/// elements rather than each seeing all of them — so ``consume()`` vends the
/// stream exactly once and returns `nil` afterwards. `nil` rather than a second,
/// empty stream is the point: an empty stream must mean "nothing happened",
/// never "could not tell", and a view that silently received an empty stream
/// would sit there looking correct and never refresh.
///
/// Fan-out was considered and rejected. SwiftUI views come and go, so the
/// temptation is to let each one iterate the hub; the cost is one buffer per
/// consumer, which multiplies the very memory this bounded buffer exists to
/// cap, and each buffer drops independently, so two views would see different
/// truncations of the same history and diverge — with no way to tell, because
/// the elements are hints and a missed hint looks like no news. The one
/// consumer is the app root: it re-reads snapshots through the core executor
/// and publishes them into `@Observable` state that every view reads, so every
/// view sees identical state from one buffer. The cost of that choice is that
/// the single consumer must not do slow work inline.
///
/// **Nothing wires this yet, and that is not a claim that it is done.** The
/// first producer is T143's `Keychain` (`secureStoreLocked`); the first
/// consumer is the app root serving T158's `SyncStatusView`, which is the first
/// view whose content is a value the core computed and must therefore refresh
/// on a hint. Until both land this file has no production call site.
final class CoreEvents: Sendable {
    /// 256 elements, from the contract. See ``CoreEvent`` for why lossy is
    /// correct and why it would not be if elements were deltas.
    static let bufferCapacity = 256

    /// Handed to every producer. One value, shared; it holds only the
    /// continuation.
    let emitter: CoreEventEmitter

    private let continuation: AsyncStream<CoreEvent>.Continuation
    private let unclaimed: Mutex<AsyncStream<CoreEvent>?>

    init() {
        let (stream, continuation) = AsyncStream.makeStream(
            of: CoreEvent.self,
            bufferingPolicy: .bufferingNewest(Self.bufferCapacity)
        )
        self.continuation = continuation
        self.unclaimed = Mutex(stream)
        self.emitter = CoreEventEmitter { _ = continuation.yield($0) }
    }

    /// Takes the stream. Returns `nil` on every call after the first, because
    /// the hub has exactly one consumer.
    func consume() -> AsyncStream<CoreEvent>? {
        unclaimed.withLock { stream in
            let claimed = stream
            stream = nil
            return claimed
        }
    }

    /// Ends the stream. Buffered elements are still delivered; anything emitted
    /// afterwards is dropped, which is what a seam callback arriving after
    /// sign-out must do rather than crash.
    func finish() {
        continuation.finish()
    }
}
