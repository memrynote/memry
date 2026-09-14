import MemryCore
import Observation
import SwiftUI

// T147, split out of `AuthRootView.swift` by T237 — that file was at exactly
// its 400-line ceiling and the next edit had to take the seam it already had.
// Nothing below changed in the move except the two lines T237 added, which are
// marked.
//
// **This is where the shell first reaches the core.** Everything in
// `Memry/Core` and `Memry/Seams` had zero production call sites before this
// file: `CoreExecutor`, `CoreEvents`, `ErrorMapping`, `Log`, `Keychain` and
// `URLSessionTransport` were implemented, tested behind substituted platforms,
// and never constructed. They are constructed here.

/// Builds the session once, and says so out loud when it cannot.
@MainActor
@Observable
final class AuthStartup {
    enum Phase {
        case starting
        case ready(SignInViewModel)
        /// The app cannot reach the core. **Not** a tenth auth state: the auth
        /// machine has no instance yet, which is a different thing from being
        /// signed out.
        case unavailable(UserFacingError)
    }

    private(set) var phase: Phase = .starting

    /// The hub's emitter, handed down from the app root.
    ///
    /// **T158 moved the hub itself out of this object** (spec-defect 92). This
    /// file used to construct `CoreEvents` and carry a comment saying its
    /// stream must not be taken here; `ShellState` now owns the hub and hands
    /// this object only a `CoreEventEmitter`, so the rule is held by what this
    /// type can reach rather than by a comment.
    private let emitter: CoreEventEmitter
    private let executor = CoreExecutor.shared

    /// T152's dependency. **No longer a gap.**
    ///
    /// Unlocking by recovery phrase needs the account's `{kdfSalt,
    /// keyVerifier}` (chapter 02 §2.1.1), and until T163 nothing in this build
    /// could supply them — so this stayed `nil` in production and the route
    /// below was dark. `start(in:)` now sets it to `CoreAccountKeyMaterial`
    /// over the session it just built.
    ///
    /// The initializer parameter survives as a **test override** only, and it
    /// is the override rather than the production value: a test that wants a
    /// scripted source passes one, and a test that passes none gets the real
    /// one, so the production path is what runs unless a test says otherwise.
    private(set) var keyMaterial: (any AccountKeyMaterialSource)?
    private let keyMaterialOverride: (any AccountKeyMaterialSource)?

    /// T155's dependency: the session the vault registry is read through.
    ///
    /// Held rather than handed only to `SignInViewModel`, because the vault
    /// list is a second consumer of the **same** session — a second one would
    /// be a second device registration (chapter 02 §2.9).
    private(set) var session: (any AuthSessionProtocol)?

    /// **T237.** The same session, unwrapped.
    ///
    /// `Vault.sync(session:)` takes the core's concrete `AuthSession` and there
    /// is no protocol to hand it, so the vault pull cannot go through
    /// `RevocationWatch`. It does not need to: a revoked device's pull fails
    /// with `ApiError.DeviceRevoked` nested in `SyncError.Api`, which
    /// `ErrorMapping` renders, and every other authenticated call on the
    /// account still goes through the watch that performs the wipe. Held
    /// rather than rebuilt, because a second `AuthSession` over the same
    /// keychain entries is a chapter 02 §2.9 device registration.
    private(set) var coreSession: AuthSession?

    /// T153/T154's dependency, and the production call site spec-defect 114
    /// stayed open for. Built in `start(in:)` beside the session, over the
    /// same transport and the same keychain.
    private(set) var deviceLink: (any DeviceLinkProtocol)?

    /// T159's dependency, and FR-025's only affordance. Built in `start(in:)`
    /// over the session, so the destruction runs against the same core object
    /// every other screen reads.
    private(set) var account: AccountViewModel?
    /// Held so ``publish(_:)`` can rebuild the sign-in screen without building
    /// a second flow.
    private var google: GoogleSignInFlow?

    private let transportConfiguration: URLSessionConfiguration
    private let keychainItems: any KeychainItemStore

    /// - Parameters:
    ///   - emitter: the app root's hub emitter. **Required, with no default**:
    ///     a discarding default would let a call site forget the hub silently.
    ///   - keyMaterial: a scripted account read, for a test that wants one.
    ///     Production passes nothing and gets `CoreAccountKeyMaterial`.
    ///   - transportConfiguration: substitutes the network **under** the real
    ///     `URLSessionTransport`, exactly as `AuthComposition` does. Production
    ///     passes the default.
    ///   - keychainItems: substitutes `SecItem*` **under** the real
    ///     `Keychain`. Production passes the default.
    ///
    /// The last two exist so that the genuine launch path — this object, the
    /// real composition, the real seams — is what a test drives, rather than a
    /// reconstruction of it that can drift. That is the difference the previous
    /// phase paid for five times over.
    init(
        emitter: CoreEventEmitter,
        keyMaterial: (any AccountKeyMaterialSource)? = nil,
        transportConfiguration: URLSessionConfiguration = URLSessionTransport.defaultConfiguration(),
        keychainItems: any KeychainItemStore = SystemKeychainItemStore()
    ) {
        self.emitter = emitter
        keyMaterialOverride = keyMaterial
        self.keyMaterial = keyMaterial
        self.transportConfiguration = transportConfiguration
        self.keychainItems = keychainItems
    }

    /// The unlock screen for a device the core reports as registered.
    ///
    /// `nil` when there is nothing to unlock with. Whether the screen is
    /// **needed** is a separate question and a separate call — see
    /// ``isAlreadyUnlocked()``, which is T155's half of it.
    func unlockModel(for state: AuthState) -> RecoveryPhraseViewModel? {
        guard state == .registered, let keyMaterial else { return nil }
        return RecoveryPhraseViewModel(
            executor: executor,
            source: keyMaterial,
            secureStore: Keychain(emitter: emitter, items: keychainItems)
        )
    }

    /// T153/T154. The device-linking flow, for a registered device that has
    /// no master key yet — the same moment ``unlockModel(for:)`` answers, and
    /// the other way through it.
    ///
    /// `nil` before the core object exists, which is the rule the two screens
    /// above follow: `UnlockRouteView` then offers only the phrase, because an
    /// affordance leading nowhere is worse than its absence.
    ///
    /// The camera is the shell's (spec-defect 107: nothing exported accepts a
    /// `CodeCapture`), so the scanner is constructed here and the view model
    /// drives it, handing the decoded string to the core unread.
    func linkModel(for state: AuthState) -> DeviceLinkingViewModel? {
        guard state == .registered, let deviceLink else { return nil }
        return DeviceLinkingViewModel(
            link: deviceLink,
            capture: QRCodeScanner(emitter: emitter),
            secureStore: Keychain(emitter: emitter, items: keychainItems),
            executor: executor
        )
    }

    /// T155. The vault picker for an account that is unlocked.
    ///
    /// `nil` before the session exists, which is the same rule
    /// ``unlockModel(for:)`` follows: no session, no account, nothing to list.
    /// The opener is built here rather than inside the view model so that the
    /// production graph — the real `VaultFiles`, the process's one executor,
    /// the core's own registry read — is what the screen runs on.
    ///
    /// **T237.** The mint is what closes spec-defect 136. Without it the
    /// screen opens a local database that nothing has ever filled and reports
    /// "no notes" against an account holding ninety-four; with it, the browse
    /// surface sits on the far side of `VaultSync.firstSync`.
    func vaultModel(for state: AuthState) -> VaultSelectionViewModel? {
        guard state == .registered, let session else { return nil }
        return VaultSelectionViewModel(
            registry: CoreVaultRegistry(session: session),
            opener: CoreVaultOpener(
                files: VaultFiles(emitter: emitter),
                executor: executor
            ),
            mint: coreSession.map { CoreVaultFillerMint(session: $0, executor: executor) }
        )
    }

    /// Whether this device has nothing left to unlock — T155's half of the
    /// question T152 left open.
    ///
    /// Chapter 01 §1.6 stores exactly one master key per account, and §1.7
    /// derives every vault's key from it with **no** per-vault input. So a
    /// device that already holds the master key is unlocked for every vault on
    /// the account, and asking for the 24 words again would be a screen with
    /// nothing to do.
    ///
    /// A keychain read that **throws** is not "no key":
    /// `errSecInteractionNotAllowed` is a phone that has not been unlocked since
    /// boot, and `Keychain` already surfaces that as locked rather than absent.
    /// Reading it as "unlocked" would skip the only screen that could recover,
    /// so "could not tell" answers `false` and the phrase screen stays.
    func isAlreadyUnlocked() -> Bool {
        do {
            return try Keychain(emitter: emitter, items: keychainItems).get(key: .masterKey) != nil
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.secureStore.error("could not tell whether the master key is present", .code(mapped.code))
            return false
        }
    }

    /// T159. The state the core applied after a sign-out or a revocation,
    /// re-read into the screens.
    ///
    /// A new `SignInViewModel` over the **same** session, never a second graph:
    /// a second `AuthSession` over the same keychain entries is what chapter 02
    /// §2.9 turns into a device revocation. It is also how the first state
    /// after launch is published, so there is one path and not two.
    private func publish(_ state: AuthState) {
        guard let session else { return }
        phase = .ready(SignInViewModel(session: session, executor: executor, state: state, google: google))
    }

    /// `RevocationWatch`'s handler. `false` means the destruction did not run,
    /// and the watch then unlatches so the next refusal tries again.
    private func revocationDetected() async -> Bool {
        guard let account else { return false }
        return await account.revocationDetected()
    }

    func begin() async {
        guard case .starting = phase else { return }
        switch SyncEnvironment.current {
        case let .misconfigured(fault):
            let mapped = fault.userFacing
            // `fault` is the one level on by default on a user's device, which
            // is where a build shipped without its server setting is found.
            Log.app.fault("this build has no usable sync environment", .code(mapped.code))
            phase = .unavailable(mapped)
        case let .resolved(environment):
            await start(in: environment)
        }
    }

    private func start(in environment: SyncEnvironment) async {
        do {
            // `UIDevice` is main-actor work, so the descriptor is built here
            // and crosses into the executor as a value.
            let descriptor = try AuthComposition.device()
            let hints = emitter
            let configuration = transportConfiguration
            let items = keychainItems
            let graph = try await executor.run {
                try AuthComposition.makeGraph(
                    environment: environment,
                    device: descriptor,
                    emitter: hints,
                    transportConfiguration: configuration,
                    keychainItems: items
                )
            }
            let session = graph.session
            self.session = session
            // T237. The unwrapped session, for `Vault.sync(session:)`.
            coreSession = session
            deviceLink = graph.deviceLink
            // **T165, spec-defect 121.** `AuthSession::new` builds the machine
            // in `SignedOut` whatever the keychain holds, so before this line a
            // registered user who quit the app was shown the sign-in screen
            // with a working refresh token on disk, every single launch.
            // `restore()` is the §C.1 edge that reads the store and reopens the
            // session. It is **synchronous and makes no request** — a launch
            // that awaited a refresh could suspend for an hour and could not be
            // cancelled (spec-defects 108, 109) — so it blocks, and a blocking
            // core call goes through the executor. It replaces the `state()`
            // read that used to be here: it returns the state it found, so
            // there is still no instant at which a state nobody reported is on
            // screen.
            let state = try await executor.run { try session.restore() }
            // **T159, FR-026.** A revocation is only ever learned from a call
            // the app was making anyway, so the detection sits where every
            // authenticated call passes rather than on the one screen somebody
            // remembered to wire. The watch is what the rest of the app is
            // handed; the service under it holds the unwrapped session, so the
            // wipe cannot re-enter its own watcher.
            account = AccountViewModel(
                service: SignOutService(
                    session: session,
                    content: VaultContentRemover(files: VaultFiles(emitter: emitter)),
                    executor: executor
                ),
                publish: { [weak self] state in self?.publish(state) }
            )
            let watched = RevocationWatch(session: session) { [weak self] in
                guard let self else { return false }
                return await revocationDetected()
            }
            self.session = watched
            // No URL, no address, no token: `Log` accepts a `StaticString` and
            // a number and there is nowhere to put one.
            Log.app.notice("auth session constructed")
            // Through the watch, not around it: an account read is an
            // authenticated call and is exactly where a revocation lands.
            keyMaterial = keyMaterialOverride ?? CoreAccountKeyMaterial(session: watched)
            // T165. The production Google flow, over the **same** transport the
            // session got: one `URLSession` in the process, not two. `nil` when
            // this build carries no `MemryGoogleClientID` — the button is still
            // offered and `SignInViewModel` renders `notConfigured`.
            if let flow = AuthComposition.googleSignIn(transport: graph.transport) {
                google = { try await flow.signIn() }
            }
            publish(state)
        } catch {
            // Construction, or the restore probe. A `restore()` that throws is
            // a keychain that could not be **read** — not a session that is not
            // there — so the one thing this must not do is fall through to the
            // sign-in screen: that is spec-defect 121 one layer down, and it
            // invites a user with a live session to register a second device.
            // `secureStore.locked`'s own copy is the right sentence for it and
            // already says to unlock the phone and open Memry again.
            let mapped = ErrorMapping.userFacing(error)
            Log.app.fault("the auth session could not be constructed or restored", .code(mapped.code))
            phase = .unavailable(mapped)
        }
    }
}
