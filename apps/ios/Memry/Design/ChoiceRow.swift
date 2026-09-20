import SwiftUI

// A row that is a decision: a symbol, what it does, what it costs, and a
// chevron saying the screen changes.
//
// **Two lines, because one is not enough here.** The choices this is used for —
// a phrase or a nearby computer — are not obvious from their names, and the
// user picks by what they have to hand. The second line is the fact that
// decides it.
//
// **One tinted row at most, and the caller decides which.** `DESIGN.md`: the
// tint fills, and one intense colour moment is stronger than five. The tint
// never carries the meaning on its own; the title does.
struct ChoiceRow: View {
    let symbol: String
    let title: String
    let detail: String
    /// The recommended route, filled with the product accent. Decoration on top
    /// of a row that already reads without it.
    var tinted = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Space.inset) {
                Image(systemName: symbol)
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(
                        tinted ? Tokens.Tint.base.color : Tokens.Text.primary.color
                    )
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .background(
                        (tinted ? Tokens.Tint.base.color.opacity(0.1) : Tokens.Canvas.surface.color),
                        in: .rect(cornerRadius: Tokens.Radius.card)
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    Text(title)
                        .font(Tokens.Typography.heading.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                    Text(detail)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityHidden(true)
            }
            .padding(Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Tokens.Radius.panel)
                    .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
        .accessibilityAddTraits(.isButton)
    }
}
