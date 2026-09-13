import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T146, the `Reachability` half.
//
// **Every history here is compared whole.** The seam has two outputs per
// transition — the core's observer, then the UI hint — and their *order* is the
// contract (`CoreEvents.swift`, the `.reachability` topic), so asserting counts
// would pass with the two swapped. Comparing the whole recorded history makes a
// missing call, a duplicated call, a wrong value and a wrong order four
// distinct failures of one assertion.
//
// **Nothing here drains a fixed count from an `AsyncStream`** (spec-defect 99).
// The recorder below is a synchronous sink built straight onto
// `CoreEventEmitter`, so the ordering evidence never touches a stream at all;
// the one test that does use the real hub emits a sentinel, calls `finish()`
// and drains to completion, so a missing yield fails instead of hanging.

/// One thing the seam did, in the order it did it.
private enum Step: Equatable {
    /// A call into the core's observer. Swift to Rust, the allowed direction.
    case observer(Reachable)
    /// A hint to the UI.
    case event(CoreEvent.Topic)
}

private final class Recorder: Sendable {
    let steps = Mutex<[Step]>([])

    var emitter: CoreEventEmitter {
        CoreEventEmitter { event in
            self.steps.withLock { $0.append(.event(event.topic)) }
        }
    }

    func append(_ step: Step) {
        steps.withLock { $0.append(step) }
    }

    var history: [Step] {
        steps.withLock { $0 }
    }
}

/// Stands in for the core's `ReachabilityObserver`, which is implemented in
/// Rust. Conforms to the generated protocol, so the call under test is the real
/// foreign-trait call shape.
private final class RecordingObserver: ReachabilityObserver, @unchecked Sendable {
    private let recorder: Recorder

    init(_ recorder: Recorder) {
        self.recorder = recorder
    }

    func onChange(reachable: Reachable) {
        recorder.append(.observer(reachable))
    }
}

/// An observer that reads the seam back from inside its own callback, the way
/// the core will: `onChange` runs on the monitor's queue while the seam is
/// mid-transition. It records what `current()` said at that moment.
private final class ReentrantObserver: ReachabilityObserver, @unchecked Sendable {
    let seen = Mutex<[Reachable]>([])
    private let seam: Mutex<PathReachability?> = Mutex(nil)

    func attach(_ reachability: PathReachability) {
        seam.withLock { $0 = reachability }
    }

    func onChange(reachable: Reachable) {
        let current = seam.withLock { $0 }?.current()
        seen.withLock { $0.append(current ?? .offline) }
    }
}

private final class FakePathSource: NetworkPathSource, @unchecked Sendable {
    private(set) var started = false
    private(set) var cancelled = false
    private var sink: (@Sendable (ObservedPath) -> Void)?

    func start(sink: @escaping @Sendable (ObservedPath) -> Void) {
        started = true
        self.sink = sink
    }

    func cancel() {
        cancelled = true
    }

    /// What `NWPathMonitor` does on its queue.
    func deliver(_ path: ObservedPath) {
        sink?(path)
    }
}

private func path(
    satisfied: Bool = true,
    expensive: Bool = false,
    constrained: Bool = false,
    unmetered: Bool = false
) -> ObservedPath {
    ObservedPath(
        isSatisfied: satisfied,
        isExpensive: expensive,
        isConstrained: constrained,
        hasUnmeteredInterface: unmetered
    )
}

@Suite("PathReachability")
struct PathReachabilityTests {
    /// The whole mapping, every shape the platform can present.
    ///
    /// Sixteen rows rather than four examples, because each of the three rules
    /// is a single `if` and an example-per-rule leaves the interactions
    /// untested: a hotspot is expensive *and* Wi-Fi, Low Data Mode is
    /// constrained *and* Wi-Fi, and an unrecognised interface is satisfied with
    /// nothing else true. Those three rows are the ones that move when a rule
    /// is dropped.
    @Test("every path shape maps to exactly one variant")
    func classifiesEveryPathShape() {
        var inputs: [ObservedPath] = []
        for satisfied in [false, true] {
            for expensive in [false, true] {
                for constrained in [false, true] {
                    for unmetered in [false, true] {
                        inputs.append(
                            path(
                                satisfied: satisfied,
                                expensive: expensive,
                                constrained: constrained,
                                unmetered: unmetered
                            )
                        )
                    }
                }
            }
        }

        let expected: [Reachable] = [
            // Not satisfied: offline, whatever else the path says about itself.
            .offline, .offline, .offline, .offline,
            .offline, .offline, .offline, .offline,
            // Satisfied, cheap, unconstrained: unmetered interface or unknown.
            .cellular, .wifi,
            // Satisfied, cheap, constrained: Low Data Mode, including on Wi-Fi.
            .cellular, .cellular,
            // Satisfied, expensive: cellular, including a Wi-Fi hotspot.
            .cellular, .cellular,
            .cellular, .cellular
        ]

        #expect(inputs.map(PathReachability.classify) == expected)
    }

    /// The rule that keeps the outbox off the rocks: a satisfied path this
    /// build cannot name is usable, so it must not read as no network.
    @Test("a path that could not be classified is not reported as offline")
    func unknownIsNotOffline() {
        let unknown = path(satisfied: true)

        #expect(PathReachability.classify(unknown) != .offline)
        #expect(PathReachability.classify(unknown) == PathReachability.unknownPath)
    }

    @Test("the monitor starts with the seam and stops when it is released")
    func startsAndStopsTheMonitor() {
        let source = FakePathSource()
        do {
            let reachability = PathReachability(emitter: Recorder().emitter, source: source)
            #expect(source.started)
            #expect(reachability.current() == PathReachability.unknownPath)
        }

        #expect(source.cancelled)
    }

    /// Before the first path arrives there is nothing to report, and the thing
    /// this must not report is offline.
    @Test("an unreported path reads as usable, never as offline")
    func seedsWithAUsablePath() {
        let source = FakePathSource()
        let reachability = PathReachability(emitter: Recorder().emitter, source: source)

        #expect(reachability.current() != .offline)
        #expect(reachability.current() == .cellular)
    }

    /// Known bug 6, closed on the shell's side: **every** transition reaches the
    /// core, including Wi-Fi to Cellular, which is the one a shell that only
    /// watches for offline-to-online silently drops.
    @Test("every transition is handed to the observer, Wi-Fi to Cellular included")
    func reportsEveryTransition() {
        let recorder = Recorder()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: recorder.emitter, source: source)
        reachability.observe(observer: RecordingObserver(recorder))

        source.deliver(path(satisfied: false))
        source.deliver(path(unmetered: true))
        // A personal hotspot: still a Wi-Fi interface, now expensive.
        source.deliver(path(expensive: true, unmetered: true))
        source.deliver(path(unmetered: true))
        source.deliver(path(satisfied: false))

        #expect(recorder.history == [
            .observer(.offline), .event(.reachability),
            .observer(.wifi), .event(.reachability),
            .observer(.cellular), .event(.reachability),
            .observer(.wifi), .event(.reachability),
            .observer(.offline), .event(.reachability)
        ])
        #expect(reachability.current() == .offline)
    }

    /// A transition is a change in the value the core can see. `NWPathMonitor`
    /// republishes a path for reasons `Reachable` cannot express, and telling
    /// the core to drain the outbox again on each one would be this seam
    /// deciding when to sync.
    @Test("a path that classifies the same as the last one is not a transition")
    func reportsNothingWithoutAChange() {
        let recorder = Recorder()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: recorder.emitter, source: source)
        reachability.observe(observer: RecordingObserver(recorder))

        // Classifies as cellular, which is what the seam already reports.
        source.deliver(path(expensive: true))
        source.deliver(path(unmetered: true))
        // A different path, the same variant: a DNS change on the same Wi-Fi.
        source.deliver(path(unmetered: true))

        #expect(recorder.history == [.observer(.wifi), .event(.reachability)])
        #expect(reachability.current() == .wifi)
    }

    /// `observe` is dispatched by UniFFI on the Rust thread that is
    /// registering, and a Swift method Rust calls must not re-enter the core
    /// (`contracts/shell-seams.md`). Registering is also not a transition.
    @Test("registering an observer calls nothing back into the core")
    func registrationIsSilent() {
        let recorder = Recorder()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: recorder.emitter, source: source)
        source.deliver(path(unmetered: true))
        let before = recorder.history

        reachability.observe(observer: RecordingObserver(recorder))

        #expect(before == [.event(.reachability)])
        #expect(recorder.history == before)
    }

    /// The UI is told whether or not the core is listening yet — the hint means
    /// "re-read", and a status view that missed the first transition would sit
    /// there saying offline.
    @Test("a transition before any observer still reaches the UI and current()")
    func reportsWithoutAnObserver() {
        let recorder = Recorder()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: recorder.emitter, source: source)

        source.deliver(path(unmetered: true))

        #expect(recorder.history == [.event(.reachability)])
        #expect(reachability.current() == .wifi)
    }

    @Test("a second registration replaces the first")
    func replacesTheObserver() {
        let first = Recorder()
        let second = Recorder()
        let events = Recorder()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: events.emitter, source: source)

        reachability.observe(observer: RecordingObserver(first))
        source.deliver(path(unmetered: true))
        reachability.observe(observer: RecordingObserver(second))
        source.deliver(path(satisfied: false))

        #expect(first.history == [.observer(.wifi)])
        #expect(second.history == [.observer(.offline)])
    }

    /// The observer is a call into Rust that takes the core's own locks, so it
    /// must happen outside this seam's mutex — and the state must already be
    /// updated when it does, or the core reads the value it is being told about
    /// as the previous one.
    ///
    /// **A regression hangs this test rather than failing it**, because a
    /// recursive acquisition of a `Mutex` does not return. The time limit is
    /// the backstop; the hang itself is the signal, and it is confined to this
    /// one test on purpose.
    @Test("the observer can read the seam back, and sees the new value", .timeLimit(.minutes(1)))
    func callsTheObserverOutsideTheLock() {
        let source = FakePathSource()
        let observer = ReentrantObserver()
        let reachability = PathReachability(emitter: Recorder().emitter, source: source)
        observer.attach(reachability)
        reachability.observe(observer: observer)

        source.deliver(path(unmetered: true))
        source.deliver(path(satisfied: false))

        #expect(observer.seen.withLock { $0 } == [.wifi, .offline])
    }

    /// The same evidence through the real hub, once, so the emitter above is
    /// not the only thing ever asserted.
    ///
    /// Drains to completion after a sentinel and a `finish()`, so a missing
    /// yield is a failed comparison rather than a parked `await`.
    @Test("hints reach the real event hub, in order, once per transition", .timeLimit(.minutes(1)))
    func emitsIntoTheHub() async {
        let hub = CoreEvents()
        let source = FakePathSource()
        let reachability = PathReachability(emitter: hub.emitter, source: source)

        source.deliver(path(unmetered: true))
        source.deliver(path(unmetered: true))
        source.deliver(path(expensive: true))
        hub.emitter.emit(CoreEvent(.scenePhase))
        hub.finish()

        let stream = hub.consume()
        #expect(stream != nil)
        var received: [CoreEvent] = []
        for await event in stream! {
            received.append(event)
        }

        #expect(received == [
            CoreEvent(.reachability),
            CoreEvent(.reachability),
            CoreEvent(.scenePhase)
        ])
        #expect(reachability.current() == .cellular)
    }
}
