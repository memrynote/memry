import MemryCore
import SwiftUI

// IB21. Inbox Zero (Paper 21, desktop `empty.*`): a calm glyph, the title,
// what to do next, and the week's two numbers as quiet facts.

struct InboxZeroView: View {
    let stats: InboxStatsRecord?
    @ScaledMetric(relativeTo: .title) private var glyph: CGFloat = 56

    var body: some View {
        VStack(spacing: Tokens.Space.small + 2) {
            Image(systemName: "checkmark")
                .font(Tokens.Typography.sectionTitle.font.weight(.bold))
                .foregroundStyle(Tokens.Task.complete.color)
                .frame(width: glyph, height: glyph)
                .background(Tokens.Canvas.surface.color, in: .circle)
                .accessibilityHidden(true)
            Text(InboxCopy.zeroTitle)
                .font(Tokens.Typography.sectionTitle.font.weight(.bold))
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(.top, Tokens.Space.small - 2)
                .accessibilityAddTraits(.isHeader)
            Text(InboxCopy.zeroBody)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .multilineTextAlignment(.center)
            if let stats, stats.filedThisWeek > 0 || stats.currentStreak > 0 {
                HStack(spacing: Tokens.Space.inset) {
                    Text(InboxCopy.filedThisWeek(Int(stats.filedThisWeek)))
                        .foregroundStyle(Tokens.Text.primary.color)
                    Text(InboxCopy.dayStreak(Int(stats.currentStreak)))
                        .foregroundStyle(Tokens.Text.tint.color)
                }
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .padding(.top, Tokens.Space.small)
            }
        }
        .frame(maxWidth: .infinity)
        // Paper 21 sets the block a third of the way down, not under the title.
        .padding(.top, Tokens.Space.screenBlock * 4)
        .padding(.horizontal, Tokens.Space.screenInline + Tokens.Space.section - 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("inbox.zero")
    }
}
