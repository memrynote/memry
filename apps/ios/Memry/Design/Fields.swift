import SwiftUI

// The two pieces of chrome that more than one setup screen needs: a labelled
// text field, and the rule that separates two ways of doing the same thing.
//
// **A label, not a placeholder.** A placeholder disappears the moment the user
// types, which leaves a filled field with nothing saying what is in it — the
// failure VoiceOver users hit first and sighted users hit when they come back
// to a half-finished form. The placeholder stays as an example of the format.
//
// **The border is `Line.border`, never the tint.** `DESIGN.md`: a boundary that
// carries state is ink-derived, because the tint is a colour the user picks and
// no contrast requirement can rest on it.

/// A field with a permanent label above it.
struct FieldGroup<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(label.uppercased())
                .font(Tokens.Typography.caption.font)
                .tracking(1)
                .foregroundStyle(Tokens.Text.secondary.color)
            content
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(.horizontal, Tokens.Space.inset)
                .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.small)
                .background(
                    RoundedRectangle(cornerRadius: Tokens.Radius.card)
                        .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
                )
        }
        // One element: the label names the field the rotor lands on, instead of
        // being a second stop that says a word with nothing to do.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// The rule between two alternatives — an email code and a provider.
///
/// Hidden from assistive technology: "or" with no context is noise, and both
/// buttons already say what they do.
struct OrDivider: View {
    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            line
            Text("OR")
                .font(Tokens.Typography.caption.font)
                .tracking(1)
                .foregroundStyle(Tokens.Text.secondary.color)
            line
        }
        .padding(.vertical, Tokens.Space.small)
        .accessibilityHidden(true)
    }

    private var line: some View {
        Rectangle()
            .fill(Tokens.Line.border.color)
            .frame(height: Tokens.Size.hairline)
    }
}
