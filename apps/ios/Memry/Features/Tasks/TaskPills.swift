import SwiftUI

// RD01p. The capsules the redesign builds with (Paper artboards 03, 08):
//
// - ``TaskPill``: a detail property (status, priority, When, project, tag),
//   a neutral capsule, or tinted by the value's own domain colour.
// - ``TaskComposerChip``: a composer property chip: neutral while unset,
//   tinted by its value once set.
// - ``TaskAddPill``: the dashed "+" that reveals the unset properties.
// (`chromeGlass(in:)` and `SheetConfirmButton` moved to `Design/` when the
// Inbox needed them, spec 006 IB032.)
//
// Every capsule keeps a 44pt hit frame around a smaller visual, so touch
// geometry stays native while the capsule reads light.

/// The look of a pill: neutral, or carried by a domain colour.
enum TaskPillTone: Equatable {
    case neutral
    /// Text and glyph in `color`, the fill a wash of it.
    case tinted(AdaptiveColor)
    /// Text and glyph in `color` on the neutral fill (the detail's When pill).
    case inked(AdaptiveColor)

    var foreground: Color {
        switch self {
        case .neutral: Tokens.Text.primary.color
        case let .tinted(color), let .inked(color): color.color
        }
    }

    var fill: Color {
        switch self {
        case .neutral, .inked: Tokens.Canvas.surfaceActive.color
        case let .tinted(color): color.color.opacity(Tokens.Palette.chipFillAlpha)
        }
    }
}

/// A capsule label: an optional leading glyph, the text, optional trailing
/// glyphs (the repeat and bell marks inside the When pill).
struct TaskPillLabel<Leading: View>: View {
    let text: String
    var tone: TaskPillTone = .neutral
    var trailingSymbols: [String] = []
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            leading()
            Text(text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            ForEach(trailingSymbols, id: \.self) { symbol in
                Image(systemName: symbol)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
        }
        .font(Tokens.Typography.supporting.font)
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, Tokens.Space.medium)
        .padding(.vertical, Tokens.Space.tight + Tokens.Size.hairline)
        .frame(minHeight: Tokens.Size.pill)
        .background(tone.fill, in: .capsule)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
    }
}

extension TaskPillLabel where Leading == EmptyView {
    init(text: String, tone: TaskPillTone = .neutral, trailingSymbols: [String] = []) {
        self.init(text: text, tone: tone, trailingSymbols: trailingSymbols) { EmptyView() }
    }
}

/// A leading SF Symbol for a pill, sized to the pill text.
struct TaskPillSymbol: View {
    let name: String
    var color: Color?

    var body: some View {
        Image(systemName: name)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(color ?? Tokens.Text.secondary.color)
            .accessibilityHidden(true)
    }
}

/// A composer chip: an icon-only circle while its property is unset and has
/// no name worth showing ("#", "…"), or a capsule with its value.
struct TaskComposerChip<Leading: View>: View {
    /// `nil` draws an icon-only chip.
    let text: String?
    var tone: TaskPillTone = .neutral
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            leading()
            if let text {
                Text(text).lineLimit(1)
            }
        }
        .font(Tokens.Typography.supporting.font.weight(.medium))
        .foregroundStyle(tone == .neutral ? Tokens.Text.secondary.color : tone.foreground)
        .padding(.horizontal, text == nil ? Tokens.Space.small : Tokens.Space.medium)
        .frame(minWidth: Tokens.Size.pill, minHeight: Tokens.Size.pill)
        .background(tone.fill, in: .capsule)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
    }
}

/// The dashed "+" pill that reveals the properties a task has not set.
struct TaskAddPill: View {
    var body: some View {
        Image(systemName: "plus")
            .font(Tokens.Typography.caption.font.weight(.semibold))
            .foregroundStyle(Tokens.Text.tertiary.color)
            .frame(minWidth: Tokens.Size.pill, minHeight: Tokens.Size.pill)
            .overlay {
                Circle().strokeBorder(
                    Tokens.Line.focus.color,
                    style: StrokeStyle(lineWidth: Tokens.Size.hairline, dash: [Tokens.Space.tight, Tokens.Space.tight / 2])
                )
            }
            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
    }
}
