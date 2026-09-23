import Foundation
import MemryCore
import Network
import Synchronization

/// T146. The `Reachability` seam over `NWPathMonitor`
/// (`crates/memry-core/src/seams/reachability.rs`, FR-030).
///
/// **This seam interprets nothing.** It reports whether there is a usable path
/// and whether that path is metered, and it maps those two facts onto the three
/// variants the core gave it. What `Offline`, `Wifi` or `Cellular` *means* —
/// whether to pull, how wide a body window is, when to retry — is the core's,
/// and none of it is computed here. There is no timer here, no backoff, no
/// debounce of when to sync.
///
/// **Both directions live in this file, and they are not the same direction.**
///
///   * ``current()`` and ``observe(observer:)`` are called **by Rust**, through
///     UniFFI, synchronously on the calling Rust thread while the core may hold
///     a lock. Neither may re-enter the core
///     (`contracts/shell-seams.md` §"There is no event seam"). `current()`
///     reads a cached value under this object's own mutex and returns;
///     `observe` stores the observer and returns, and deliberately does **not**
///     deliver a first value, because registering is not a transition.
///   * ``ReachabilityObserver/onChange(reachable:)`` is implemented in **Rust**
///     and called from **Swift**, from the monitor's queue. That is the allowed
///     direction, and it is the whole point of this task: the seam doc says a
///     queued wave drains *on the transition* only if the shell wires
///     `observe`, and that a shell which never does still syncs — on its own
///     timer, with the ten-minutes-in-a-lift delay the doc describes.
///
/// The observer is called **outside** this object's mutex. It is a call into
/// Rust that will take core locks of its own, and holding a shell lock across
/// it is how two lock orders meet.
///
/// **A path this seam could not classify is never reported as `Offline`.**
/// "Could not tell" is not "no network": reporting an unclassifiable but
/// satisfied path as offline parks the outbox on a working connection, which is
/// the one failure this seam can cause on its own. See ``classify(_:)`` and
/// ``PathReachability/unknownPath``.
final class PathReachability: Reachability {
    /// What this seam reports before the monitor has delivered a single path,
    /// and the answer to "satisfied, but by an interface we do not recognise".
    ///
    /// **Not `.offline`**, for the reason in the type doc. Not `.wifi` either:
    /// `Wifi` is documented as "a path the core treats as unmetered", and
    /// claiming that about a path we have not seen spends a stranger's data
    /// plan on a wide first-sync body window. `Cellular` is the honest
    /// unknown — usable, metered — and it costs a narrower body window on a
    /// path that turns out to be Wi-Fi, for the few milliseconds before the
    /// first real path arrives.
    static let unknownPath: Reachable = .cellular

    /// The path an attachment download is judged against (FR-045).
    ///
    /// Its own monitor rather than the sync engine's, because nothing else
    /// in the shell constructs one yet (`ShellState`), and without a real
    /// path every attachment read `unknownPath` — metered — and an
    /// unmetered-only picture never downloaded, on Wi-Fi or anywhere else.
    /// The emitter drops its hint: a download asks `current()` at the moment
    /// it starts and has no use for the transition.
    static let forAttachments = PathReachability(emitter: CoreEventEmitter { _ in })

    private struct State {
        var reachable: Reachable
        /// The core's observer. Singular, as the trait's doc has it; a second
        /// registration replaces the first rather than accumulating, so this
        /// cannot grow a list of observers the core no longer holds.
        var observer: ReachabilityObserver?
    }

    private let state = Mutex(State(reachable: PathReachability.unknownPath, observer: nil))
    private let emitter: CoreEventEmitter
    private let source: any NetworkPathSource

    /// Starts the monitor. **In `init`, on purpose**: a seam with a separate
    /// `start()` is a seam that ships unstarted, and an unstarted monitor
    /// reports ``unknownPath`` forever with nothing failing anywhere.
    ///
    /// - Parameter source: the platform's path stream, injected so the
    ///   classification and the transition plumbing can be driven through paths
    ///   a simulator cannot be made to produce — a constrained path, an
    ///   expensive Wi-Fi hotspot, an interface this build has never heard of.
    ///   Production passes the default.
    init(emitter: CoreEventEmitter, source: any NetworkPathSource = NWPathMonitorSource()) {
        self.emitter = emitter
        self.source = source
        source.start { [weak self] path in
            self?.pathChanged(path)
        }
    }

    deinit {
        source.cancel()
    }

    // MARK: - Reachability, called from Rust

    func current() -> Reachable {
        state.withLock { $0.reachable }
    }

    /// Registers the core's observer, and **calls nothing**.
    ///
    /// Dispatched on the Rust thread that is registering, which may hold the
    /// connection's lock; delivering a value from here would be a re-entrant
    /// call into the core from inside the core's own call. It is also not owed:
    /// the engine reads ``current()`` at the top of every pass, so the state at
    /// registration time is already available to it by the channel built for
    /// it. What the observer is for is the *change*.
    func observe(observer: ReachabilityObserver) {
        state.withLock { $0.observer = observer }
    }

    // MARK: - The transition, called from the monitor's queue

    /// One path update from the platform.
    ///
    /// **A transition is a change in the value the core can see**, not an
    /// `NWPath` update. `NWPathMonitor` republishes a path whenever anything
    /// about it changes — an interface reordering, a DNS change, a gateway —
    /// and `onChange` carries nothing but a ``Reachable``, so redelivering the
    /// same variant tells the core nothing it does not already have while
    /// asking it to drain the outbox again.
    ///
    /// Every *real* transition is reported, including `Wifi` to `Cellular`,
    /// which the trait's doc calls out because a shell that only watches for
    /// offline-to-online misses the metered-ness change entirely.
    private func pathChanged(_ path: ObservedPath) {
        let next = Self.classify(path)
        let transition: (happened: Bool, observer: ReachabilityObserver?) = state.withLock { current in
            guard current.reachable != next else { return (false, nil) }
            current.reachable = next
            return (true, current.observer)
        }
        guard transition.happened else { return }

        log(next)
        // Swift into Rust, from the monitor's queue and outside the lock. This
        // is the call the queued wave drains on.
        transition.observer?.onChange(reachable: next)
        // Only then the UI, and only as a hint to re-read (`CoreEvents.swift`).
        emitter.emit(CoreEvent(.reachability))
    }

    /// The whole mapping, and the only judgement in this file.
    ///
    /// Three rules, in order:
    ///
    ///   1. **A path the platform does not call satisfied is offline.** That is
    ///      the platform's own answer, not a reading of one. `requiresConnection`
    ///      lands here too: a path that would need something to happen first is
    ///      not a path that carries a request now.
    ///   2. **Metered beats interface.** `isExpensive` is true for cellular
    ///      *and* for a personal hotspot, which arrives as a Wi-Fi interface,
    ///      and `isConstrained` is Low Data Mode, which a user can set on a
    ///      Wi-Fi network. `Wifi` means "the core treats this as unmetered", so
    ///      neither may be reported as `Wifi`. `Cellular` is the only metered
    ///      variant there is.
    ///   3. **`Wifi` is claimed only when we affirmatively recognise an
    ///      unmetered interface.** Anything else satisfied — a VPN, an
    ///      interface type this build predates — is ``unknownPath``, never
    ///      offline.
    static func classify(_ path: ObservedPath) -> Reachable {
        guard path.isSatisfied else { return .offline }
        if path.isExpensive || path.isConstrained { return .cellular }
        return path.hasUnmeteredInterface ? .wifi : unknownPath
    }

    /// One literal per variant, because `Log`'s messages are `StaticString` and
    /// a runtime value cannot be interpolated into one (`Log.swift`). Nothing
    /// here names a host, an interface or an address.
    private func log(_ reachable: Reachable) {
        switch reachable {
        case .offline: Log.transport.notice("network path became offline")
        case .wifi: Log.transport.notice("network path became unmetered")
        case .cellular: Log.transport.notice("network path became metered")
        }
    }
}

/// The four facts this seam reads off an `NWPath`, and nothing else.
///
/// Deliberately shaped as the platform's own answers rather than as a decision:
/// a substitute supplies what the framework would have said, so the
/// classification under test is the real one. There is no `isUnknown` — an
/// unknown path is a satisfied one with no recognised interface, which is a
/// shape the platform can actually produce.
struct ObservedPath: Sendable, Equatable {
    let isSatisfied: Bool
    let isExpensive: Bool
    let isConstrained: Bool
    /// Wi-Fi or wired Ethernet. Both are unmetered; a wired path is what an
    /// iPad with an adapter reports, and what a simulator reports on a Mac.
    let hasUnmeteredInterface: Bool
}

/// The platform's path stream, behind a protocol for one reason: a test cannot
/// make a machine's real network become constrained, become an expensive
/// hotspot, or present an interface type this build has never seen.
protocol NetworkPathSource: AnyObject, Sendable {
    /// Starts delivering paths. Called exactly once, from the seam's `init`.
    func start(sink: @escaping @Sendable (ObservedPath) -> Void)
    func cancel()
}

/// The real monitor.
final class NWPathMonitorSource: NetworkPathSource, @unchecked Sendable {
    private let monitor = NWPathMonitor()
    /// `.utility`: a path update is never on a user's critical path, and this
    /// queue is also the thread the core's observer runs on, so it must not be
    /// one the UI is waiting behind.
    private let queue = DispatchQueue(label: "com.memry.ios.reachability", qos: .utility)

    func start(sink: @escaping @Sendable (ObservedPath) -> Void) {
        monitor.pathUpdateHandler = { path in
            sink(ObservedPath(path))
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        monitor.cancel()
    }
}

extension ObservedPath {
    /// Field reads, no policy. Every judgement about these values is in
    /// ``PathReachability/classify(_:)``, where a test can reach it.
    init(_ path: NWPath) {
        self.init(
            isSatisfied: path.status == .satisfied,
            isExpensive: path.isExpensive,
            isConstrained: path.isConstrained,
            hasUnmeteredInterface: path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
        )
    }
}
