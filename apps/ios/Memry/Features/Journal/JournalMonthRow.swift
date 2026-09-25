import SwiftUI

// JP043. One day on the Month screen (Paper J05, desktop
// `journal-entry-list-item.tsx`): activity dot, day number, short weekday,
// the preview or its placeholder, and a Today badge. The whole row is one
// button and one VoiceOver element ("Thursday 24, entry, <preview>").

struct JournalMonthRow: View {
    let model: JournalMonthRowModel
    let open: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: open) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    // AX sizes: the preview gets its own line (JP057).
                    VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                        HStack(spacing: Tokens.Space.medium) {
                            dateParts
                            Spacer(minLength: 0)
                            badge
                        }
                        preview
                    }
                } else {
                    HStack(spacing: Tokens.Space.medium) {
                        dateParts
                        preview
                            .frame(maxWidth: .infinity, alignment: .leading)
                        badge
                    }
                }
            }
            .padding(.horizontal, Tokens.Space.medium)
            .padding(.vertical, Tokens.Space.small)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background {
                if model.isToday {
                    RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous)
                        .fill(Tokens.Canvas.surface.color)
                }
            }
            .contentShape(.rect)
            .opacity(model.opacity)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityValue(model.isToday ? JournalCopy.today : "")
        .accessibilityHint(JournalCopy.openDayHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("journal.month.day.\(model.date)")
    }

    private var dateParts: some View {
        HStack(spacing: Tokens.Space.medium) {
            JournalActivityDot(level: model.level)
            Text("\(model.day)")
                .font(Tokens.Typography.subsectionTitleSemibold.monospacedDigit())
                .foregroundStyle(model.isToday ? Tokens.Text.tint.color : Tokens.Text.primary.color)
                .frame(minWidth: dayColumnWidth, alignment: .leading)
            Text(JournalCopy.weekdayShort(model.weekday))
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .frame(minWidth: weekdayColumnWidth, alignment: .leading)
        }
    }

    private var preview: some View {
        Text(model.state.text)
            .font(Tokens.Typography.supporting.font)
            .italic(model.state.isPlaceholder)
            .foregroundStyle(model.state.isPlaceholder ? Tokens.Text.tertiary.color : Tokens.Text.secondary.color)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
    }

    @ViewBuilder
    private var badge: some View {
        if model.isToday {
            Text(JournalCopy.today)
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.tint.color)
                .padding(.horizontal, Tokens.Space.small)
                .padding(.vertical, Tokens.Space.tight / 2)
                .background(Tokens.Tint.base.color.opacity(Tokens.Palette.chipFillAlpha), in: .capsule)
        }
    }

    @ScaledMetric(relativeTo: .title3) private var dayColumnWidth: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var weekdayColumnWidth: CGFloat = 34
}

/// Desktop's activity dot: a filled dot at levels 1-4, a hollow ring for a
/// day with no characters. It never carries meaning alone; the row's text
/// says the same (Tokens.Journal).
struct JournalActivityDot: View {
    let level: UInt8

    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 10

    var body: some View {
        Group {
            if level > 0 {
                Circle().fill(Tokens.Journal.activity(level).color)
                    .frame(width: size, height: size)
            } else {
                Circle().strokeBorder(Tokens.Journal.activityEmpty.color, lineWidth: Tokens.Size.hairline)
                    .frame(width: size * 0.8, height: size * 0.8)
            }
        }
        .frame(width: size + 2, height: size + 2)
        .accessibilityHidden(true)
    }
}

private extension Tokens.Typography {
    /// The day number: Paper J05's 19pt semibold, tabular.
    static var subsectionTitleSemibold: Font {
        TypeRole(.subsectionTitle, weight: .semibold).font
    }
}
