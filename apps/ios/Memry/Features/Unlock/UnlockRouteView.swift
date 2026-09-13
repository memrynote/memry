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
// "having trouble?" disclosure would be choosing for them.
//
// The link screen is offered only when there is one to offer: `link` is `nil`
// when the app could not build a `DeviceLink`, and an affordance that led
// nowhere would be worse than its absence.

struct UnlockRouteView: View {
    let phrase: RecoveryPhraseViewModel
    let link: DeviceLinkingViewModel?

    @State private var showsLink = false

    var body: some View {
        if showsLink, let link {
            QRLinkView(model: link, onUsePhrase: { showsLink = false })
        } else {
            phraseScreen
        }
    }

    private var phraseScreen: some View {
        VStack(spacing: Tokens.Space.medium) {
            RecoveryPhraseView(model: phrase)
            if link != nil {
                Button("Unlock with a nearby computer") { showsLink = true }
                    .memrySecondaryAction()
                    .padding(.horizontal, Tokens.Space.screenInline)
                    .padding(.bottom, Tokens.Space.inset)
            }
        }
        .background(Tokens.Canvas.background.color)
    }
}
