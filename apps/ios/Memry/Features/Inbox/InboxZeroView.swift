import MemryCore
import SwiftUI

// IB21. Inbox Zero (Paper 21, desktop `empty.*`): a calm glyph, the title,
// what to do next, and the week's two numbers as quiet facts.

struct InboxZeroView: View {
    let stats: InboxStatsRecord?

    var body: some View {
        VStack(spacing: Tokens.Space.medium) {
            Image(systemName: "checkmark.circle")
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Task.complete.color)
                .accessibilityHidden(true)
            Text(InboxCopy.zeroTitle)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Text(InboxCopy.zeroBody)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .multilineTextAlignment(.center)
            if let stats, stats.filedThisWeek > 0 || stats.currentStreak > 0 {
                HStack(spacing: Tokens.Space.medium) {
                    fact(InboxCopy.filedThisWeek(Int(stats.filedThisWeek)))
                    fact(InboxCopy.dayStreak(Int(stats.currentStreak)))
                }
                .padding(.top, Tokens.Space.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Tokens.Space.screenBlock)
        .padding(.horizontal, Tokens.Space.inset)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("inbox.zero")
    }

    private func fact(_ text: String) -> some View {
        Text(text)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.pill)
            .background(Tokens.Canvas.surface.color, in: .capsule)
    }
}
