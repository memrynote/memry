import MemryCore
import SwiftUI

// TP043. One activity entry, drawn by the full feed (`TaskActivitySheet`).
// RD08 folded the detail's inline preview into the footer line
// (`TaskDetailFooter`), which opens that feed.

/// One entry on the timeline (`TaskActivityRow`): a rail with a dot, the
/// label and its old → new values (or the description's size change), then
/// who and when. VoiceOver reads the whole row as one sentence; the arrow is
/// decorative and mirrors in right-to-left layouts.
struct TaskActivityRow: View {
    let line: TaskActivityLine

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            Circle()
                .fill(line.isSuperseded ? Tokens.Task.dueToday.color : Tokens.Text.tertiary.color)
                .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                .padding(.top, Tokens.Space.small)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                change
                Text("\(line.actor) · \(line.time)")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Tokens.Space.tight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityText)
    }

    private var change: some View {
        FlowLayout(spacing: Tokens.Space.tight) {
            Text(line.label)
                .foregroundStyle(Tokens.Text.secondary.color)
            if let summary = line.summary {
                Text(summary)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            } else {
                if let old = line.oldText {
                    Text(old)
                        .strikethrough(line.isSuperseded)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .lineLimit(1)
                }
                if line.oldText != nil, line.newText != nil {
                    Image(systemName: "arrow.forward")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .flipsForRightToLeftLayoutDirection(true)
                }
                if let new = line.newText {
                    Text(new)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(1)
                }
            }
        }
        .font(Tokens.Typography.supporting.font)
    }
}
