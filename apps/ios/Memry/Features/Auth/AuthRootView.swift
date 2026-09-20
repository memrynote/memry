import MemryCore
import Observation
import SwiftUI

// T147. What the app shows before anything is signed in. The runtime half of
// the composition root is `AuthStartup.swift`, split out by T237 when this
// file reached its 400-line ceiling.

struct AuthRootView: View {
    @State private var startup: AuthStartup
    @State private var unlock: RecoveryPhraseViewModel?
    @State private var link: DeviceLinkingViewModel?
    @State private var vaults: VaultSelectionViewModel?
    /// First-device setup, for an account that may have no key material at all.
    ///
    /// **This is the branch a fresh signup was missing.** Before it, a
    /// registered device with no master key was always sent to the unlock
    /// screen and asked for 24 words — words an account nobody had finished
    /// setting up has never had. The model asks the server which case it is;
    /// this holds it while it does.
    @State private var setup: AccountSetupViewModel?
    /// Set once the setup model has answered "this account already has keys",
    /// so the question is asked once per screen rather than on every route.
    @State private var setupSettled = false
    /// Whether the two welcome screens have been through once on this install.
    ///
    /// A presentation preference, so `@AppStorage` and not the keychain: it
    /// carries no key material, and a user who reinstalls for a clean app is
    /// entitled to see the pitch again.
    @AppStorage("onboarding.welcomeSeen") private var welcomeSeen = false

    init(emitter: CoreEventEmitter) {
        _startup = State(initialValue: AuthStartup(emitter: emitter))
    }

    var body: some View {
        Group {
            switch startup.phase {
            case .starting:
                LaunchView()
            case let .ready(model):
                // T152. A registered device with no master key is a locked
                // vault, and the phrase is one of its two ways in (T153/T154
                // is the other). Built in `onChange` rather than in the body:
                // a model minted per render would throw away what the user had
                // typed on every keystroke.
                // T159. The account's own affordances, wrapped around whatever
                // is on screen: the way out under everything, the revoked
                // screen instead of everything.
                AccountShell(state: model.state, account: startup.account) {
                    if let vaults {
                        VaultListView(model: vaults)
                    } else if let setup {
                        AccountSetupView(
                            model: setup,
                            onEstablished: {
                                // The key is in the store now, which is the
                                // same ending a correct phrase has: the next
                                // question is which vault.
                                self.setup = nil
                                setupSettled = true
                                route(for: model.state)
                            },
                            onAlreadyConfigured: {
                                self.setup = nil
                                setupSettled = true
                                route(for: model.state)
                            }
                        )
                    } else if let unlock {
                        // T153/T154. The phrase and the nearby computer are
                        // the two ways into the same locked vault, offered
                        // together rather than one behind the other.
                        UnlockRouteView(phrase: unlock, link: link)
                    } else if welcomeSeen || model.state != .signedOut {
                        // Back only from the first sign-in: it returns to the
                        // welcome pages, and there is nothing to return to when
                        // a session expired into this screen.
                        SignInView(
                            model: model,
                            onBack: model.state == .signedOut ? { welcomeSeen = false } : nil
                        )
                    } else {
                        // Only ever before the first sign-in. A device that is
                        // signed out again later has already read this, and a
                        // session that expired is an interruption, not a
                        // first run.
                        WelcomeView { welcomeSeen = true }
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
                // T153/T154. A completed link ends the unlock step exactly as
                // a correct phrase does: the master key is in the store, so
                // §C.2's `Unlocking -> Unlocked` has happened by the other
                // road and the next question is still which vault.
                .onChange(of: link?.isLinked ?? false) { _, _ in
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
            link = nil
            vaults = nil
            setup = nil
            setupSettled = false
            return
        }
        if unlock?.isUnlocked == true || link?.isLinked == true || startup.isAlreadyUnlocked() {
            unlock = nil
            link = nil
            setup = nil
            // A device holding the master key has nothing to set up, and must
            // not spend a round trip asking.
            setupSettled = true
        } else if !setupSettled {
            // **Nothing else is built until this answers.** The setup model is
            // asking the server whether the account has key material at all,
            // and every screen after it depends on which answer comes back.
            // Building the vault list beside it is what put "No vaults yet" in
            // front of a brand-new account instead of its recovery phrase: the
            // body renders the vault list first, so the phrase screen existed
            // and was never reached.
            if setup == nil { setup = startup.accountSetupModel(for: state) }
            return
        } else if unlock == nil {
            unlock = startup.unlockModel(for: state)
            link = startup.linkModel(for: state)
        }
        if setup == nil, unlock == nil, vaults == nil {
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
        NoticeScreen(
            symbol: "exclamationmark.triangle",
            title: error.title,
            // `DESIGN.md`: an error the user cannot act on still gets a second
            // sentence. A mapped error without guidance has none to give, so
            // this one says the only thing that is true on every screen that
            // can show it — nothing on the phone was touched.
            detail: error.guidance ?? "Nothing on this phone was changed. Open Memry again later."
        ) {
            EmptyView()
        }
    }
}
