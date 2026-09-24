import SwiftUI

// TP048. Small controls the filter sheet and its panels share.

/// A quick preset capsule (artboard 13): the ink fill when it is the filters
/// now applied, the neutral fill otherwise.
struct TaskFilterPresetButton: View {
    let preset: TaskFilterPreset
    let isActive: Bool
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: action) {
            Text(TasksCopy.presetLabel(preset))
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                // One line at regular sizes; at accessibility sizes the
                // capsules stack full width and the label may wrap.
                .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
                .font(Tokens.Typography.supporting.font.weight(isActive ? .medium : .regular))
                .foregroundStyle(isActive ? Tokens.Interaction.actionForeground.color : Tokens.Text.primary.color)
                .padding(.horizontal, Tokens.Space.medium)
                .frame(minHeight: Tokens.Size.pill)
                .background(
                    isActive ? Tokens.Interaction.actionFill.color : Tokens.Canvas.surfaceActive.color,
                    in: .capsule
                )
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .accessibilityIdentifier("tasks.filter.preset.\(preset.rawValue)")
    }
}

/// A multi-select row with a trailing checkmark.
struct TaskFilterCheckRow<Leading: View>: View {
    let title: String
    let isSelected: Bool
    var count: Int?
    let identifier: String
    @ViewBuilder let leading: () -> Leading
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Space.small) {
                leading()
                Text(title)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: Tokens.Space.small)
                if let count {
                    Text("\(count)")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .monospacedDigit()
                }
                Image(systemName: "checkmark")
                    .foregroundStyle(Tokens.Text.primary.color)
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .font(Tokens.Typography.body.font)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
    }
}
