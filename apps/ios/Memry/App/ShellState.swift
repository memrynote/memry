import MemryCore
import Observation
import SwiftUI

// T158 (rescoped, Kaan 2026-09-14), spec-defect 92. **The hub's one consumer.**
//
// `CoreEvents` landed with T141 — implemented, tested, and consumed by nobody.
// Every hint every seam emitted went into a 256-element buffer that nothing
// drained, which is the Phase 3 failure shape exactly: a tier that is finished
// and never wired. This file is the other end.
//
// **Three rules this file is built to keep.**
//
//   1. **One consumer, and it is this one.** `CoreEvents.consume()` vends the
//      stream once and answers `nil` afterwards. The enforcement here is
//      structural rather than a comment: ``ShellState`` is the only thing in
//      the target that *holds* a `CoreEvents`, and it holds it privately. What
//      the rest of the app gets is ``ShellState/emitter``, a
//      `CoreEventEmitter`, whose entire surface is a synchronous `Void`
//      `emit`. `AuthStartup` used to own the hub and had to be told in a doc
//      comment not to take its stream; it now cannot, because it is never
//      handed one.
//   2. **A hint causes a re-read; it is never the data.** The handler below
//      reads a snapshot and publishes the snapshot. Nothing off the stream —
//      no scope, no identifier — reaches a view, which is why a lossy buffer
//      is sound.
//   3. **A re-read must not itself be a producer.** ``KeychainProbe`` builds
//      its `Keychain` over a *discarding* emitter. Pointed at the app's own
//      hub it would emit `secureStoreLocked` from inside the handler for
//      `secureStoreLocked`, and the consumer would spin on its own output for
//      as long as the phone stayed locked.

/// Whether the shell can read its own keys right now.
///
/// Three cases rather than a `Bool`, because "could not tell" must not render
/// as "fine" — that collapse is the bug `ErrorMapping` exists to refuse.
enum SecureStoreAvailability: Sendable, Equatable {
    /// The store answered. Whether an entry was *there* is a different
    /// question and not this one.
    case readable
    /// `errSecInteractionNotAllowed`: the entries exist and are unreadable
    /// until this phone is unlocked once.
    case locked
    /// Nothing has been read yet, or the read failed for some other reason.
    case undetermined
}

/// One keychain read, with no effect on the hub.
protocol SecureStoreProbe: Sendable {
    func availability() -> SecureStoreAvailability
}

/// The production probe: the real `Keychain` over the real `SecItem*` family.
struct KeychainProbe: SecureStoreProbe {
    private let items: any KeychainItemStore

    init(items: any KeychainItemStore = SystemKeychainItemStore()) {
        self.items = items
    }

    func availability() -> SecureStoreAvailability {
        // Discarding, and that is rule 3 above. Never `ShellState`'s emitter.
        let store = Keychain(emitter: CoreEventEmitter { _ in }, items: items)
        do {
            _ = try store.get(key: .masterKey)
            return .readable
        } catch let error as SecureStoreError {
            guard case .Locked = error else {
                Log.secureStore.error("the key store could not be read", .code(ErrorMapping.userFacing(error).code))
                return .undetermined
            }
            return .locked
        } catch {
            Log.secureStore.error("the key store could not be read", .code(ErrorMapping.userFacing(error).code))
            return .undetermined
        }
    }
}

/// What the app root publishes, and what every view reads instead of the
/// stream.
@MainActor
@Observable
final class ShellState {
    /// How the loop ended. Returned rather than logged only, so a test can
    /// assert the single-consumer rule and the cancellation without reading
    /// the system log back — which a simulator does not do reliably.
    enum Outcome: Sendable, Equatable {
        /// The hub finished.
        case finished
        /// The owning task was cancelled. The loop stopped; nothing is left
        /// running.
        case cancelled
        /// `consume()` answered `nil`, so somebody else already took the
        /// stream. **Not** a second, empty stream: this instance publishes
        /// nothing and says so.
        case unavailable
    }

    private let events = CoreEvents()
    private let probe: any SecureStoreProbe

    /// The only thing producers are handed. See rule 1.
    var emitter: CoreEventEmitter { events.emitter }

    /// The one degraded state this phase can actually observe, rendered
    /// through `ErrorMapping` like everything else (Constitution II).
    ///
    /// `nil` unless the store is `locked`. `undetermined` deliberately shows
    /// nothing: a sentence claiming the phone is locked when we could not tell
    /// is worse than silence, and the reason is already in the log.
    private(set) var secureStore: SecureStoreAvailability = .undetermined

    var secureStoreNotice: UserFacingError? {
        secureStore == .locked ? ErrorMapping.userFacing(SecureStoreError.Locked) : nil
    }

    init(probe: any SecureStoreProbe = KeychainProbe()) {
        self.probe = probe
    }

    /// Drains the hub for as long as the owner lives.
    ///
    /// **Structured, and therefore not leakable.** This is awaited from
    /// `RootView`'s `.task`, which SwiftUI cancels when the view goes away; a
    /// detached `Task` here would outlive its owner with nobody holding it,
    /// which is the failure that cost this project a night. A cancelled
    /// `for await` over an `AsyncStream` ends the iteration, so cancellation
    /// returns from this function rather than merely flagging it.
    @discardableResult
    func consume() async -> Outcome {
        guard let stream = events.consume() else {
            // `fault` is the one level on by default on a user's device. A
            // second consumer is a wiring bug, not a runtime condition.
            Log.app.fault("the event hub was already consumed, so this instance publishes nothing")
            return .unavailable
        }
        for await event in stream {
            handle(event)
        }
        return Task.isCancelled ? .cancelled : .finished
    }

    /// The shell's own producer, named in `CoreEvents.Topic.scenePhase`.
    ///
    /// Only `.active`. iOS reports no keychain-unlock notification, so coming
    /// back to the foreground is the moment at which a store that read as
    /// locked can be asked again — and unlocking the phone is exactly what the
    /// user was told to do.
    func scenePhaseChanged(to phase: ScenePhase) {
        guard phase == .active else { return }
        emitter.emit(CoreEvent(.scenePhase))
    }

    /// One hint. Six topics, and what each of them causes to be re-read.
    private func handle(_ event: CoreEvent) {
        switch event.topic {
        case .secureStoreLocked, .scenePhase:
            // The only re-read this phase owns. `secureStoreLocked` says the
            // store just refused; `scenePhase` says the user has had the
            // chance to fix it.
            secureStore = probe.availability()
        case .storage, .capturePermission, .realtimeSocket, .reachability:
            // Drained deliberately, and re-read by nobody **here**.
            //
            // `storage` and `capturePermission` already have a reader that
            // owns them: `CoreVaultOpener` re-asserts the protection class
            // inside `VaultFiles.openingVault`, and `DeviceLinkingViewModel`
            // re-reads `permission()` from the answer the seam returns it. A
            // second re-read from the app root would be a duplicate, not a
            // fix.
            //
            // `realtimeSocket` and `reachability` have **no production
            // producer today** — `RealtimeClient` is not exported
            // (spec-defect 103) and no `PathReachability` is constructed
            // outside tests — and the screen that would read either is the
            // sync-status half of this task, which is cut. Wiring a reader
            // for a hint nothing emits is how a tier ends up finished and
            // never called.
            break
        }
    }
}
