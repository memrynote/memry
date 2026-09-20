import SwiftUI

// T153. The two ways into a locked vault, offered from the one place the
// specification puts them.
//
// **Linking is an alternative to the recovery phrase, not to the sign-in.**
// The device has already signed in and already registered by the time either
// screen exists — `AuthState.registered` is the state `AuthRootView` routes on
// — so this is a choice between two ways of obtaining the same master key
// (chapter 01 §1.6), and nothing here registers a device.
//
// **Neither is buried.** A user who has lost their phrase and a user whose
// computer is on the desk are both ordinary, and a flow that hid one behind a
// "having trouble?" disclosure would be choosing for them. So the choice is the
// screen, not a button under one of the answers — which is what this was before
// and what made the phrase the default for a user standing at their Mac.
//
// **A choice of one is not a choice.** `link` is `nil` when the app could not
// build a `DeviceLink`; the phrase screen is then the whole route, with no
// picker in front of it and no affordance leading nowhere.

struct UnlockRouteView: View {
    let phrase: RecoveryPhraseViewModel
    let link: DeviceLinkingViewModel?

    @State private var route: Route?

    enum Route: Equatable {
        case phrase
        case link
    }

    var body: some View {
        Group {
            switch resolvedRoute {
            case .link:
                if let link {
                    QRLinkView(model: link) { route = .phrase }
                }
            case .phrase:
                // The way back exists only when there is somewhere to go back
                // to: with no link model this screen is the route itself.
                RecoveryPhraseView(model: phrase, onBack: link == nil ? nil : { route = nil })
            case nil:
                chooser
            }
        }
        .calmAnimation(.normal, value: route)
    }

    /// With no link model there is nothing to choose between, so the phrase is
    /// the route from the first frame.
    private var resolvedRoute: Route? {
        link == nil ? .phrase : route
    }

    private var chooser: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                header
                VStack(spacing: Tokens.Space.medium) {
                    ChoiceRow(
                        symbol: "qrcode.viewfinder",
                        title: "Scan your computer",
                        detail: "Fastest if Memry is already unlocked on a computer nearby.",
                        tinted: true
                    ) { route = .link }
                    ChoiceRow(
                        symbol: "key",
                        title: "Enter your recovery phrase",
                        detail: "The 24 words you saved when you created this account."
                    ) { route = .phrase }
                }
                footnote
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("Unlock your vault")
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("This phone is signed in, but your notes are still sealed. Pick whichever key you have to hand.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// What is true when the user has neither key, stated rather than hidden.
    /// It promises no way out, because this build has none to offer: the vault
    /// stays sealed, and saying so is better than a button that cannot.
    private var footnote: some View {
        Text("Without one of these, the notes already in your account stay sealed. Memry cannot open them for you.")
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
