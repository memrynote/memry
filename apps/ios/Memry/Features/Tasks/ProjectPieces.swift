import MemryCore
import SwiftUI

// TP052. Small pieces the project screens share: the project's icon, the
// colour palette (desktop's `color-picker.tsx`) and a hub progress bar
// (`rail-progress.tsx`).

/// A project's icon: its emoji, else a folder symbol in the project colour.
struct ProjectIconView: View {
    let icon: String?
    let color: String

    var body: some View {
        Group {
            if let emoji = ProjectIconValue.emoji(icon) {
                Text(emoji)
            } else {
                Image(systemName: "folder.fill")
                    .foregroundStyle(Tokens.Palette.color(color))
            }
        }
        .font(Tokens.Typography.heading.font)
        .frame(minWidth: Tokens.Size.minimumHitArea / 2)
        .accessibilityHidden(true)
    }
}

/// The ten desktop swatches, one selected.
struct ProjectColorPalette: View {
    let selection: String
    let onSelect: (String) -> Void
    var identifierPrefix = "tasks.projectColor"

    var body: some View {
        FlowLayout(spacing: Tokens.Space.small) {
            ForEach(ProjectPalette.swatches) { swatch in
                let isSelected = swatch.hex.caseInsensitiveCompare(selection) == .orderedSame
                Button { onSelect(swatch.hex) } label: {
                    Circle()
                        .fill(Tokens.Palette.color(swatch.hex))
                        .frame(width: Tokens.Space.section + Tokens.Space.tight,
                               height: Tokens.Space.section + Tokens.Space.tight)
                        .overlay {
                            if isSelected {
                                Image(systemName: "checkmark")
                                    .font(Tokens.Typography.caption.font.weight(.bold))
                                    .foregroundStyle(Tokens.Interaction.actionForeground.color)
                            }
                        }
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.Projects.colorName(swatch.id))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .accessibilityIdentifier("\(identifierPrefix).\(swatch.id)")
            }
        }
    }
}

/// `{done} of {total} done`, the percentage and the bar, plus overdue.
struct ProjectProgressView: View {
    let stats: ProjectStats?

    var body: some View {
        let total = Int(stats?.taskCount ?? 0)
        let done = Int(stats?.completedCount ?? 0)
        let overdue = Int(stats?.overdueCount ?? 0)
        let percent = total == 0 ? 0 : Int((Double(done) / Double(total) * 100).rounded())
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Text(TasksCopy.Projects.doneOf(done: done, total: total))
                    .foregroundStyle(Tokens.Text.secondary.color)
                Spacer()
                Text(TasksCopy.Projects.percent(percent))
                    .monospacedDigit()
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            .font(Tokens.Typography.supporting.font)
            ProgressView(value: Double(percent), total: 100)
                .tint(Tokens.Task.progress.color)
                .accessibilityLabel(TasksCopy.Projects.progress)
                .accessibilityValue(TasksCopy.Projects.percent(percent))
            if overdue > 0 {
                Label {
                    HStack {
                        Text(TasksCopy.Projects.overdue)
                        Spacer()
                        Text("\(overdue)").monospacedDigit()
                    }
                } icon: {
                    Image(systemName: "exclamationmark.circle")
                }
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Task.dueOverdue.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.projectProgress")
    }
}
