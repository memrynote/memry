import SwiftUI

// The screen between the app icon leaving the springboard and the core
// reporting a state — `AuthStartup.Phase.starting`.
//
// **It says what is happening.** The previous build showed a bare
// `ProgressView`, and a spinner alone cannot distinguish "reading the keychain"
// from "hung". `restore()` makes no request, so this is normally a single
// frame; the sentence is for the launch where the keychain is slow, and it
// promises no duration (`DESIGN.md`: never render a duration the user cannot
// use).
struct LaunchView: View {
    var body: some View {
        VStack {
            Spacer()
            BrandLockup(markHeight: 44, role: Tokens.Typography.sectionTitle)
            Spacer()
            Text("Restoring your session")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .padding(.bottom, Tokens.Space.section)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.Canvas.background.color)
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    LaunchView()
}
