import MemryCore
import Observation
import SwiftUI

// T147. What the app shows before anything is signed in, and the runtime half
// of the composition root.
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

    /// The process's one event hub.
    ///
    /// **Its stream is deliberately not taken here.** `CoreEvents.consume()`
    /// vends the stream once and returns `nil` on every later call, and the
    /// single consumer is **T158's** (spec-defect 92) — along with §7.15's
    /// runtime obligations on `purged_documents` and `advanced_documents`, and
    /// the `snapshot_is_due` poll (spec-defect 100), which are the app root's
    /// and which T158 owns. The hub exists now only because `Keychain` and
    /// `URLSessionTransport` cannot be constructed without an emitter.
    private let events = CoreEvents()
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
    private let transportConfiguration: URLSessionConfiguration
    private let keychainItems: any KeychainItemStore

    /// - Parameters:
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
        keyMaterial: (any AccountKeyMaterialSource)? = nil,
        transportConfiguration: URLSessionConfiguration = URLSessionTransport.defaultConfiguration(),
        keychainItems: any KeychainItemStore = SystemKeychainItemStore()
    ) {
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
            secureStore: Keychain(emitter: events.emitter, items: keychainItems)
        )
    }

    /// T155. The vault picker for an account that is unlocked.
    ///
    /// `nil` before the session exists, which is the same rule
    /// ``unlockModel(for:)`` follows: no session, no account, nothing to list.
    /// The opener is built here rather than inside the view model so that the
    /// production graph — the real `VaultFiles`, the process's one executor,
    /// the core's own registry read — is what the screen runs on.
    func vaultModel(for state: AuthState) -> VaultSelectionViewModel? {
        guard state == .registered, let session else { return nil }
        return VaultSelectionViewModel(
            registry: CoreVaultRegistry(session: session),
            opener: CoreVaultOpener(
                files: VaultFiles(emitter: events.emitter),
                executor: executor
            )
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
            return try Keychain(emitter: events.emitter, items: keychainItems).get(key: .masterKey) != nil
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.secureStore.error("could not tell whether the master key is present", .code(mapped.code))
            return false
        }
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
            let emitter = events.emitter
            let configuration = transportConfiguration
            let items = keychainItems
            let graph = try await executor.run {
                try AuthComposition.makeGraph(
                    environment: environment,
                    device: descriptor,
                    emitter: emitter,
                    transportConfiguration: configuration,
                    keychainItems: items
                )
            }
            let session = graph.session
            self.session = session
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
            // No URL, no address, no token: `Log` accepts a `StaticString` and
            // a number and there is nowhere to put one.
            Log.app.notice("auth session constructed")
            keyMaterial = keyMaterialOverride ?? CoreAccountKeyMaterial(session: session)
            var google: GoogleSignInFlow?
            // T165. The production Google flow, over the **same** transport the
            // session got: one `URLSession` in the process, not two. `nil` when
            // this build carries no `MemryGoogleClientID` — the button is still
            // offered and `SignInViewModel` renders `notConfigured`.
            if let flow = AuthComposition.googleSignIn(transport: graph.transport) {
                google = { try await flow.signIn() }
            }
            phase = .ready(SignInViewModel(
                session: session,
                executor: executor,
                state: state,
                google: google
            ))
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

struct AuthRootView: View {
    @State private var startup = AuthStartup()
    @State private var unlock: RecoveryPhraseViewModel?
    @State private var vaults: VaultSelectionViewModel?

    var body: some View {
        Group {
            switch startup.phase {
            case .starting:
                ProgressView()
                    .controlSize(.large)
            case let .ready(model):
                // T152. A registered device with no master key is a locked
                // vault, and the phrase is one of its two ways in (T153/T154
                // is the other). Built in `onChange` rather than in the body:
                // a model minted per render would throw away what the user had
                // typed on every keystroke.
                Group {
                    if let vaults {
                        VaultListView(model: vaults)
                    } else if let unlock {
                        RecoveryPhraseView(model: unlock)
                    } else {
                        SignInView(model: model)
                    }
                }
                .onChange(of: model.state, initial: true) { _, state in
                    route(for: state)
                }
                // T155. The phrase screen's success is what ends it: the master
                // key is in the store, so §C.2's `Unlocking -> Unlocked` has
                // happened and the next question is which vault.
                .onChange(of: unlock?.isUnlocked ?? false) { _, _ in
                    route(for: model.state)
                }
            case let .unavailable(error):
                AuthUnavailableView(error: error)
            }
        }
        .task { await startup.begin() }
    }

    /// Which of the three screens this state means.
    ///
    /// Models are held rather than re-minted, because both of them own work in
    /// progress: a phrase half-typed, a vault half-opened. The only two moments
    /// that discard one are leaving `registered` — a sign-out or a revocation,
    /// where keeping a vault list alive would be showing an account nobody is
    /// signed into — and an unlock completing.
    private func route(for state: AuthState) {
        guard state == .registered else {
            unlock = nil
            vaults = nil
            return
        }
        if unlock?.isUnlocked == true || startup.isAlreadyUnlocked() {
            unlock = nil
        } else if unlock == nil {
            unlock = startup.unlockModel(for: state)
        }
        if unlock == nil, vaults == nil {
            vaults = startup.vaultModel(for: state)
        }
    }
}

/// The screen for a build that cannot reach a server at all.
///
/// A system `ContentUnavailableView` rather than a hand-built one: dynamic
/// type, RTL mirroring and the accessibility grouping come from the platform,
/// and there is nothing here worth reimplementing to own.
private struct AuthUnavailableView: View {
    let error: UserFacingError

    var body: some View {
        ContentUnavailableView {
            Label(error.title, systemImage: "exclamationmark.triangle")
        } description: {
            if let guidance = error.guidance {
                Text(guidance)
            }
        }
    }
}
