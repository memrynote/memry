import MemryCore
import SwiftUI

// T154. The short verification code, and the wait for the computer to approve.
//
// **The code is the security check, not decoration.** §3.6: six decimal digits
// computed independently on both devices from the raw scalarmult output, so a
// user comparing them is comparing the key agreement itself. Nothing is
// transferred until the computer's user has approved — §3.9 has the approving
// device verify `newDeviceConfirm` **before it touches the master key** — so
// this screen's only job is to make the comparison easy and honest.
//
// **It is the accessibility-critical element on the flow.** It is read aloud
// and compared across two screens, so the digits are spelled out one at a time
// rather than spoken as "two hundred and forty-six thousand", the digits are
// monospaced so they cannot be confused by proportional kerning, and nothing
// about the state is carried by colour alone.
//
// **The window is rendered coarsely and honestly.** §3.4's TTL is the
// server's, absolute from `initiate`, and neither the scan nor the approval
// extends it. So the screen shows whole minutes from the server's `expiresAt`
// — never a hardcoded 300, never a ticking second count, which `DESIGN.md`
// refuses and which would turn a careful comparison into a race.
//
// **Expiry is its own screen**, not an error about the user's eyesight, and it
// offers the one thing that works: a new code from the computer.

struct SASConfirmView: View {
    @Bindable var model: DeviceLinkingViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                switch model.phase {
                case .expired: expired
                case .linked: linked
                default: comparison
                }
                if let error = model.error {
                    ErrorNotice(error: error, code: model.visibleErrorCode)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
    }

    // MARK: - Comparing

    @ViewBuilder
    private var comparison: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.section) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text("Check these match")
                    .font(Tokens.Typography.screenTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text(
                    "Your computer is showing the same six digits. If they match, approve the link there. "
                        + "Nothing is sent to this phone until you do."
                )
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            // The code, the window it lives in and the wait are one block:
            // they are the one thing on this screen, and three loose lines on
            // the canvas read as three unrelated remarks.
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                if let sasCode = model.sasCode {
                    VerificationCode(digits: sasCode)
                }
                window
                waiting
            }
            .padding(Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.panel))

            Button("Stop") { Task { await model.stop() } }
                .memrySecondaryAction()
        }
    }

    /// The window, in the words the chapter's own TTL supports.
    ///
    /// `nil` minutes means the window has closed but no poll has reported it
    /// yet, which is at most one cadence away — so the sentence says the code
    /// is about to expire rather than claiming a number it no longer has.
    @ViewBuilder
    private var window: some View {
        Group {
            Text(Self.windowText(minutes: model.minutesRemaining))
        }
        .font(Tokens.Typography.supporting.font)
        .foregroundStyle(Tokens.Text.secondary.color)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `nil` minutes: the window has closed but no poll has said so yet.
    static func windowText(minutes: Int?) -> String {
        switch minutes {
        case .none: "This code is about to expire."
        case .some(1): "This code expires in about a minute."
        case let .some(value): "This code expires in about \(value) minutes."
        }
    }

    private var waiting: some View {
        // Words rather than a bare spinner, and no promise about how long the
        // person at the computer will take.
        ProgressView { Text("Waiting for your computer") }
            .progressViewStyle(.circular)
            .font(Tokens.Typography.supporting.font)
            .tint(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - The two endings

    private var expired: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Label("That code has expired", systemImage: "clock")
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("Linking codes are only good for a few minutes. Show a new one on your computer and scan it.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            Button("Start again") { Task { await model.startOver() } }
                .memryPrimaryAction()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var linked: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Label("This phone is linked", systemImage: "checkmark.seal")
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text("Your vaults are unlocked on this phone.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// §3.6's six digits, shown so they can be compared and read aloud.
///
/// Not grouped into threes: the computer shows six digits and a phone that
/// grouped them would have the user comparing two differently shaped strings
/// under time pressure. Monospaced digits, generous tracking, and a VoiceOver
/// label that spells each digit — "two, four, six" — because the default
/// reading of `246801` is "two hundred forty-six thousand eight hundred one",
/// which cannot be checked against anything.
struct VerificationCode: View {
    let digits: String

    var body: some View {
        Text(digits)
            .font(Tokens.Typography.screenTitle.font.monospaced())
            .tracking(Tokens.Space.small)
            .foregroundStyle(Tokens.Text.primary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement()
            .accessibilityLabel(Self.spokenLabel(digits))
    }

    /// "Verification code 2, 4, 6, 8, 0, 1". A comma between digits is what
    /// makes VoiceOver pause between them rather than read a number.
    static func spokenLabel(_ digits: String) -> String {
        "Verification code \(digits.map(String.init).joined(separator: ", "))"
    }
}
