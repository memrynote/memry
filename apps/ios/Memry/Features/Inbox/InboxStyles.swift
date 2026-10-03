import MemryCore
import SwiftUI

/// Device-local inbox preferences (desktop keeps them local too, §5 F11).
enum InboxPreferences {
    static let imageModeKey = "inbox.imageFilingMode"
    static let imageModeRememberedKey = "inbox.imageFilingModeRemembered"
}

/// A tag chip: selected = filled, suggestion = outlined.
struct InboxChipStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.pill)
            .background(selected ? Tokens.Canvas.surfaceActive.color : .clear, in: .capsule)
            .overlay { if !selected { Capsule().strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline) } }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// A tag pill in the tag's own colour: chosen = tinted fill, suggestion =
/// tinted outline (desktop's tag badge).
struct InboxTagPillStyle: ButtonStyle {
    let color: Color
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Tokens.Typography.supporting.font.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.pill)
            .background(color.opacity(selected ? Tokens.Palette.chipFillAlpha : 0), in: .capsule)
            .overlay {
                Capsule().strokeBorder(color.opacity(selected ? 0 : 0.5), lineWidth: Tokens.Size.hairline)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

struct InboxTrailingIconLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Tokens.Space.tight) {
            configuration.title
            configuration.icon.font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
        }
    }
}
