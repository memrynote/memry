import MemryCore
import SwiftUI

// T159's two screens: the way out, and the screen for a phone that was put out.
//
// **Tokens only** (T160). No font, colour, spacing or radius literal appears
// below.
//
// **Red is used exactly where `DESIGN.md` says red means something**: "red
// means destructive, failed, urgent, or overdue. It does not mean emphasis."
// The sign-out control is destructive, so it is red *and* carries the system's
// destructive role, which is what gives VoiceOver the word as well as the
// colour — colour is never the only cue.
//
// **Logical edges only.** SwiftUI's `.leading`/`.trailing` are already
// direction-relative, so RTL is the default here rather than a pass; dynamic
// type comes from the type roles, and reduce-motion is branched inside
// `calmAnimation` on each evaluation rather than read once into a flag.
//
// **No Cancel over a destruction in flight** (spec-defect 108): while a
// sign-out is running the control is replaced by a progress label, not by a
// disabled button beside a stop. There is nothing that could stop it.

/// The way out of an account, offered wherever a signed-in phone is.
///
/// A bar rather than a toolbar item: the screens under it are owned by other
/// tasks (`NotesListView` owns its own toolbar and its own `NavigationStack`),
/// and an affordance this important must not depend on which of them happens to
/// be on screen. FR-025 is not reachable-on-some-screens.
struct SignOutBar: View {
    @Bindable var model: AccountViewModel
    /// `false` on a screen where the core would refuse a sign-out. The bar can
    /// still be on screen then, because a residue notice outlives the state it
    /// was produced in: the sign-out that left content behind ends in
    /// `SignedOut`, which is exactly where the control is not offered.
    var canSignOut = true

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let residue = model.residue {
                ErrorNotice(error: residue, code: nil)
            }
            if let error = model.error {
                ErrorNotice(error: error, code: nil)
            }
            if canSignOut { control }
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.vertical, Tokens.Space.medium)
        .calmAnimation(.fast, value: model.isWorking)
    }

    @ViewBuilder
    private var control: some View {
        if model.isWorking {
            // A statement, not a button with a spinner in it: there is nothing
            // to press and nothing to cancel.
            Label(AccountCopy.signingOut, systemImage: "hourglass")
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityLabel(AccountCopy.signingOut)
        } else {
            Button(AccountCopy.signOut, role: .destructive) {
                model.isConfirming = true
            }
            // Same geometry as every other action in the flow, in the one
            // colour `DESIGN.md` reserves for removal. The role is still set,
            // so VoiceOver says "destructive" and the colour is not the only
            // cue.
            .buttonStyle(MemryActionStyle(kind: .destructive))
            .confirmationDialog(
                AccountCopy.confirmTitle,
                isPresented: $model.isConfirming,
                titleVisibility: .visible
            ) {
                Button(AccountCopy.signOut, role: .destructive) {
                    Task { await model.signOut() }
                }
            } message: {
                Text(AccountCopy.confirmMessage)
            }
        }
    }
}

/// data-model §C.1's `Revoked`: terminal until the user acts, shown **after**
/// the local content is gone.
///
/// It can only be built from a state the core reported, and the only thing that
/// reports that state is `SignOutService.markRevoked()`, which removes the
/// content before it returns. That ordering is why this screen is allowed to
/// say the copy has been removed.
struct RevokedView: View {
    let model: AccountViewModel

    var body: some View {
        NoticeScreen(
            symbol: "lock.slash",
            tone: .destructive,
            title: AccountCopy.revokedTitle,
            detail: AccountCopy.revokedBody
        ) {
            if let residue = model.residue {
                ErrorNotice(error: residue, code: nil)
            }
            if let error = model.error {
                ErrorNotice(error: error, code: nil)
            }
            action
        }
        .calmAnimation(.fast, value: model.isWorking)
    }

    @ViewBuilder
    private var action: some View {
        if model.isWorking {
            Label(AccountCopy.signingOut, systemImage: "hourglass")
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minHeight: Tokens.Size.minimumHitArea)
        } else {
            // Not destructive and not red: everything that could be destroyed
            // already has been, and this button only moves §C.1's last edge.
            Button(AccountCopy.revokedAction) {
                Task { await model.signInAgain() }
            }
            .memryPrimaryAction()
        }
    }
}

/// Where the account's own affordances live, wrapped around whatever the app is
/// showing.
///
/// It exists so the routing decision is written **once**, next to the two views
/// it chooses between, rather than spread through the app root: the revoked
/// screen replaces everything, and the way out sits under everything else.
///
/// **The bar is offered only from a state the core will accept it from.**
/// `sign_out` is an edge out of `Registered`, `SessionExpired` and `Revoked`
/// and nothing else (`api/auth.rs`'s table), so offering it mid-sign-in would
/// be a button whose only possible answer is `auth.invalidState` — "Memry could
/// not do that from where it is", which tells the user nothing they did wrong.
struct AccountShell<Content: View>: View {
    let state: AuthState
    let account: AccountViewModel?
    @ViewBuilder var content: () -> Content

    /// Set by a screen that offers the way out itself — the vault's More tab.
    /// The bar then stays off every other screen, where it sat over the
    /// content it was not about.
    @State private var hostedElsewhere = false

    var body: some View {
        if let account {
            switch AccountPresentation.of(state: state, hasNotice: account.hasNotice) {
            case .revoked:
                RevokedView(model: account)
            case .wayOut:
                content()
                    .environment(account)
                    .onPreferenceChange(SignOutHostedKey.self) { hostedElsewhere = $0 }
                    .safeAreaInset(edge: .bottom) {
                        if !hostedElsewhere { SignOutBar(model: account) }
                    }
            case .noticeOnly:
                content().safeAreaInset(edge: .bottom) {
                    SignOutBar(model: account, canSignOut: false)
                }
            case .plain:
                content()
            }
        } else {
            content()
        }
    }
}

/// `true` when a screen inside the shell hosts the sign-out control itself.
///
/// FR-025 asks for the way out to be reachable from every signed-in screen,
/// not drawn on every one: inside an open vault it lives in the More tab, one
/// tap from anywhere, instead of over every note.
struct SignOutHostedKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// What the shell puts around the app, as a value rather than as three `if`s
/// inside a `body`.
///
/// A free decision the suite can assert over its real inputs, which a rendered
/// `View` does not allow — the shape `Tokens.animation(_:_:reduceMotion:)`
/// already uses for the same reason.
enum AccountPresentation: Sendable, Equatable {
    /// §C.1's `Revoked`, terminal until the user acts: it replaces the screen
    /// rather than decorating it, because the content behind it is an account
    /// nobody is signed into.
    case revoked
    /// Signed in, with the way out under whatever is on screen.
    case wayOut
    /// **The case that is easy to miss.** A sign-out that left content behind
    /// ends in `SignedOut`, where the control is not offered — so without this
    /// the one notice that says "part of this phone's copy could not be
    /// removed" would be rendered on no screen at all.
    case noticeOnly
    /// Mid sign-in. Nothing to say and nothing to offer.
    case plain

    /// `sign_out` is an edge out of `Registered`, `SessionExpired` and
    /// `Revoked` and nothing else (`api/auth.rs`'s table), so offering it
    /// anywhere else would be a button whose only possible answer is
    /// `auth.invalidState` — "Memry could not do that from where it is", which
    /// tells the user nothing they did wrong.
    static func of(state: AuthState, hasNotice: Bool) -> AccountPresentation {
        if state == .revoked { return .revoked }
        if state == .registered || state == .sessionExpired { return .wayOut }
        return hasNotice ? .noticeOnly : .plain
    }
}
