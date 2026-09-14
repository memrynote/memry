import Foundation
import MemryCore
import Security
import SwiftUI
import Synchronization
import Testing

@testable import Memry

// T158, spec-defect 92. **Is the hub consumed, or does it merely compile?**
//
// `CoreEvents` shipped with T141 fully tested and drained by nobody, which is
// this project's recurring failure: a tier that is implemented, green, and
// never called. So the tests here are shaped to fail when the wiring is cut
// rather than when the hub is broken — `CoreEventsTests` already covers the
// hub itself.
//
// **Nothing here can hang.** Every wait is bounded by a deadline and returns
// `false` when it expires (spec-defect 99: an `AsyncStream` assertion that
// hung instead of failing cost twenty-one minutes of silence that looked like
// a deadlock in the seam under test). The consumer loop never ends on its own,
// so a test that waited for it to finish would be exactly that bug.

@MainActor
@Suite("ShellEvents")
struct ShellEventsTests {
    /// Polls to a deadline. Never waits forever, and answers the condition one
    /// last time so an expiry and a slow pass cannot be confused.
    private func waitUntil(
        _ seconds: Double = 3,
        _ condition: @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    /// Awaits a task's value against a deadline. `nil` means it had not
    /// finished, which is what a leaked loop looks like.
    private func outcome(
        of task: Task<ShellState.Outcome, Never>,
        within seconds: Double = 3
    ) async -> ShellState.Outcome? {
        await withTaskGroup(of: ShellState.Outcome?.self) { group in
            group.addTask { await task.value }
            group.addTask {
                try? await Task.sleep(for: .seconds(seconds))
                return nil
            }
            let first = await group.next()
            group.cancelAll()
            return first.flatMap { $0 }
        }
    }

    /// Counts its reads, so a consumer that re-read twice for one hint — or
    /// spun on its own output — is visible rather than merely slow.
    private final class CountingProbe: SecureStoreProbe {
        private let answer: SecureStoreAvailability
        private let calls = Mutex<Int>(0)

        init(_ answer: SecureStoreAvailability) { self.answer = answer }

        var count: Int { calls.withLock { $0 } }

        func availability() -> SecureStoreAvailability {
            calls.withLock { $0 += 1 }
            return answer
        }
    }

    /// **The production call-site chain, end to end.**
    ///
    /// `AuthStartup.isAlreadyUnlocked()` -> the real `Keychain` -> a
    /// `SecItemCopyMatching` answering `errSecInteractionNotAllowed` ->
    /// `CoreEventEmitter.emit` -> `ShellState`'s `AsyncStream` -> the handler
    /// -> the real `KeychainProbe` over the same store -> `secureStore`.
    ///
    /// **It fails against a fake that works.** The probe and the startup share
    /// one `RecordingKeychainItems`; hand either of them a store that answers
    /// normally and no event is ever emitted, so the notice never appears and
    /// this expires. It also fails if `ShellState.consume()` stops being
    /// awaited, which is the whole point of the task.
    @Test("a locked keychain reaches the app root's published state")
    func theRootConsumesWhatTheRealKeychainEmits() async {
        let items = RecordingKeychainItems(locked: ["master-key"])
        let shell = ShellState(probe: KeychainProbe(items: items))
        let startup = AuthStartup(emitter: shell.emitter, keychainItems: items)
        let loop = Task { await shell.consume() }
        defer { loop.cancel() }

        #expect(shell.secureStore == .undetermined)
        #expect(shell.secureStoreNotice == nil)
        // The genuine seam call. Its answer is "could not tell", and the event
        // is the part this test is about.
        #expect(startup.isAlreadyUnlocked() == false)

        #expect(await waitUntil { shell.secureStore == .locked })
        #expect(shell.secureStoreNotice?.code.description == "secureStore.locked")
        // Constitution II: what a view is handed is `UserFacingError`, and it
        // carries no identifier off the stream.
        #expect(shell.secureStoreNotice?.title.isEmpty == false)
    }

    /// A store that answers normally emits nothing, so there is nothing to
    /// consume and the root publishes nothing. The counterpart to the test
    /// above: it is what that one looks like when the seam is replaced by
    /// something that works.
    @Test("a readable keychain publishes no notice at all")
    func aWorkingStoreProducesNoHint() async {
        let items = RecordingKeychainItems()
        let probe = CountingProbe(.readable)
        let shell = ShellState(probe: probe)
        let startup = AuthStartup(emitter: shell.emitter, keychainItems: items)
        let loop = Task { await shell.consume() }
        defer { loop.cancel() }

        _ = startup.isAlreadyUnlocked()

        #expect(await waitUntil(0.3) { probe.count >= 1 } == false)
        #expect(shell.secureStore == .undetermined)
        #expect(shell.secureStoreNotice == nil)
    }

    /// The single-consumer rule, and the cancellation, in one run because the
    /// first is only meaningful once the loop has provably claimed the stream.
    @Test("the stream is claimed once, and the loop ends when its owner does")
    func theSecondConsumerIsRefusedAndTheFirstIsCancellable() async {
        let probe = CountingProbe(.locked)
        let shell = ShellState(probe: probe)
        let loop = Task { await shell.consume() }

        shell.emitter.emit(CoreEvent(.secureStoreLocked))
        // Proof the loop is running, not an assumption that it is.
        #expect(await waitUntil { shell.secureStore == .locked })

        // A second call site gets `nil` from the hub and says so, rather than
        // sitting on an empty stream and looking correct forever.
        #expect(await shell.consume() == .unavailable)

        loop.cancel()
        // **The leak evidence.** `nil` here means the loop was still running
        // after its owner cancelled it, which is the failure that cost this
        // project a night.
        #expect(await outcome(of: loop) == .cancelled)
    }

    /// Coming back to the foreground is the one moment a store that read as
    /// locked can be asked again: iOS reports no keychain-unlock notification,
    /// and unlocking the phone is what the notice asked the user to do.
    @Test("becoming active re-reads the store, and the other phases do not")
    func scenePhaseDrivesTheReread() async {
        let probe = CountingProbe(.locked)
        let shell = ShellState(probe: probe)
        let loop = Task { await shell.consume() }
        defer { loop.cancel() }

        shell.scenePhaseChanged(to: .background)
        shell.scenePhaseChanged(to: .inactive)
        #expect(await waitUntil(0.3) { probe.count >= 1 } == false)

        shell.scenePhaseChanged(to: .active)
        #expect(await waitUntil { probe.count == 1 })
    }

    /// One hint, one re-read.
    ///
    /// The guard this pins is real and invisible: `KeychainProbe` builds its
    /// `Keychain` over a **discarding** emitter. Pointed at the app's own hub
    /// it would emit `secureStoreLocked` from inside the handler for
    /// `secureStoreLocked`, and the consumer would spin on its own output for
    /// as long as the phone stayed locked. A growing count is that bug.
    @Test("a re-read is not itself a producer")
    func oneHintCausesExactlyOneReread() async {
        let probe = CountingProbe(.locked)
        let shell = ShellState(probe: probe)
        let loop = Task { await shell.consume() }
        defer { loop.cancel() }

        shell.emitter.emit(CoreEvent(.secureStoreLocked))
        #expect(await waitUntil { probe.count == 1 })
        // Long enough for a feedback loop to have run many times.
        #expect(await waitUntil(0.3) { probe.count > 1 } == false)
    }

    /// The four topics this phase deliberately drains without re-reading.
    ///
    /// They are consumed — the hub has one consumer and an unconsumed topic
    /// would just sit in a lossy buffer — but the app root owns no reader for
    /// them: `storage` and `capturePermission` are re-read by the screen that
    /// caused them, and `realtimeSocket` and `reachability` have no production
    /// producer at all today. This asserts the deliberate absence, so the day
    /// one of them gains a reader the change is visible here.
    @Test("the four unwired topics are drained and change nothing")
    func unwiredTopicsChangeNothing() async {
        let probe = CountingProbe(.locked)
        let shell = ShellState(probe: probe)
        let loop = Task { await shell.consume() }
        defer { loop.cancel() }

        shell.emitter.emit(CoreEvent(.storage, scope: .vault("vault-a")))
        shell.emitter.emit(CoreEvent(.capturePermission))
        shell.emitter.emit(CoreEvent(.realtimeSocket))
        shell.emitter.emit(CoreEvent(.reachability))
        // A sentinel the consumer *does* act on, emitted last: when its effect
        // lands, all four above have provably been consumed and ignored.
        shell.emitter.emit(CoreEvent(.secureStoreLocked))

        #expect(await waitUntil { probe.count == 1 })
        #expect(shell.secureStore == .locked)
    }

    /// The probe's own mapping. `undetermined` is the case that matters: a
    /// read that failed for some other reason must not render as "fine".
    @Test("the probe answers locked, readable and could-not-tell apart")
    func theProbeDistinguishesCouldNotTell() {
        #expect(KeychainProbe(items: RecordingKeychainItems(locked: ["master-key"])).availability() == .locked)
        #expect(KeychainProbe(items: RecordingKeychainItems()).availability() == .readable)
        #expect(KeychainProbe(items: RefusingKeychainItems()).availability() == .undetermined)
        // A store that could not be read shows no sentence, because a sentence
        // claiming the phone is locked when we could not tell is worse than
        // silence. The reason is in the log, which is where it is useful.
        let shell = ShellState(probe: CountingProbe(.undetermined))
        #expect(shell.secureStoreNotice == nil)
    }
}

/// Answers every read with `errSecNotAvailable` — neither locked nor a
/// successful read, which is the third arm of the probe.
private final class RefusingKeychainItems: KeychainItemStore, @unchecked Sendable {
    func copy(query: [String: Any]) -> (status: OSStatus, data: Data?) { (errSecNotAvailable, nil) }
    func add(attributes: [String: Any]) -> OSStatus { errSecNotAvailable }
    func update(query: [String: Any], attributes: [String: Any]) -> OSStatus { errSecNotAvailable }
    func delete(query: [String: Any]) -> OSStatus { errSecNotAvailable }
}
