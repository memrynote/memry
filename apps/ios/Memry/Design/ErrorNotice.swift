import SwiftUI

// T160. One failure, rendered — the shared view `RecoveryPhraseView.swift` was
// written against and could not call yet.
//
// It existed twice, once privately in `SignInView.swift` and once privately in
// `RecoveryPhraseView.swift`, with a comment in the second saying "the shared
// component belongs in `Memry/Design` and that file is T160's". This is that
// file, and the two copies are gone.
//
// **It renders `UserFacingError` and nothing else** (Constitution II). No raw
// error object and no payload can reach it, because there is no parameter that
// would carry one.

/// One failure, rendered.
///
/// The icon carries the recourse as well as the colour does, which is the
/// point: `DESIGN.md` rejects colour as the only state cue.
struct ErrorNotice: View {
    let error: UserFacingError
    /// Non-`nil` only for an error with no mapping, which `DESIGN.md` requires
    /// to render an identifying code. Every other message keeps its code in the
    /// log, where it is useful, and off the screen, where it is clutter.
    let code: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Label(error.title, systemImage: symbol)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(titleColor)
            if let guidance = error.guidance {
                Text(guidance)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            if let code {
                Text(code)
                    .font(Tokens.Typography.technicalCaption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Tokens.Space.inset)
        .blockSurface()
        .accessibilityElement(children: .combine)
        // `text` is title and guidance as one sentence, which is what that type
        // has it for: an alert read as two unrelated fragments loses the half
        // that matters.
        .accessibilityLabel(error.text)
    }

    /// Red only where red means what `DESIGN.md` says it means: this will not
    /// resolve itself and repeating will not help. A retryable failure is not
    /// destructive and is not painted as one.
    private var titleColor: Color {
        error.recourse == .blocked
            ? Tokens.Interaction.destructive.color
            : Tokens.Text.primary.color
    }

    private var symbol: String {
        switch error.recourse {
        case .retry: "arrow.clockwise"
        case .retryLater: "clock"
        case .blocked: "exclamationmark.triangle"
        }
    }
}
