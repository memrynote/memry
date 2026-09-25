import SwiftUI

// JP044. One month on the Year screen (Paper J06, desktop
// `journal-year-view.tsx` `MonthCard`): short name, "N days", five activity
// dots. The current month is ringed in the tint, a future month is dimmed.
// One VoiceOver element: "September, 17 days".

struct JournalYearCard: View {
    let model: JournalYearCardModel
    let open: () -> Void

    @ScaledMetric(relativeTo: .footnote) private var dotSize: CGFloat = 7

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text(JournalCopy.monthShort(model.month))
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(model.isCurrent ? Tokens.Text.tint.color : Tokens.Text.primary.color)
                Text(JournalCopy.days(model.entryCount))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                HStack(spacing: Tokens.Space.tight) {
                    ForEach(Array(model.dots.enumerated()), id: \.offset) { _, level in
                        RoundedRectangle(cornerRadius: dotSize / 2, style: .continuous)
                            .fill(level > 0 ? Tokens.Journal.activity(level).color : Tokens.Line.border.color)
                            .frame(width: dotSize, height: dotSize)
                    }
                }
            }
            .padding(Tokens.Space.medium)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea * 2, alignment: .leading)
            .background(
                model.isCurrent ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.surface.color,
                in: .rect(cornerRadius: Tokens.Radius.card, style: .continuous)
            )
            .overlay {
                if model.isCurrent {
                    RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous)
                        .strokeBorder(Tokens.Text.tint.color.opacity(Tokens.Journal.currentMonthRingAlpha), lineWidth: Tokens.Size.hairline)
                }
            }
            .contentShape(.rect(cornerRadius: Tokens.Radius.card))
            .opacity(model.isFuture ? Tokens.Journal.futureAlpha : 1)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityValue(model.isCurrent ? JournalCopy.currentMonth : "")
        .accessibilityHint(JournalCopy.openMonthHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("journal.year.month.\(model.month)")
    }
}
