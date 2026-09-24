import SwiftUI

// TP048. Small controls the filter sheet and its panels share.

/// A sheet row: the dimension, and what it is set to (or nothing).
struct TaskFilterRowLabel: View {
    let title: String
    let symbol: String
    let value: String?

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Label(title, systemImage: symbol)
                .foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.small)
            Text(value ?? TasksCopy.filterAny)
                .foregroundStyle(value == nil ? Tokens.Text.tertiary.color : Tokens.Text.secondary.color)
                .lineLimit(1)
        }
        .font(Tokens.Typography.body.font)
        .accessibilityElement(children: .combine)
    }
}

/// A single-choice menu over wire values.
struct TaskFilterChoicePicker: View {
    let title: String
    let options: [String]
    let selection: String
    let label: (String) -> String
    let identifier: String
    let onSelect: (String) -> Void

    var body: some View {
        Picker(title, selection: binding) {
            ForEach(choices, id: \.self) { option in
                Text(label(option)).tag(option)
            }
        }
        .pickerStyle(.menu)
        .font(Tokens.Typography.body.font)
        .accessibilityIdentifier(identifier)
    }

    /// A value from a newer build stays selectable rather than blanking the menu.
    private var choices: [String] {
        options.contains(selection) ? options : options + [selection]
    }

    private var binding: Binding<String> {
        Binding(get: { selection }, set: { value in if value != selection { onSelect(value) } })
    }
}

/// A quick preset pill: filled when it is the filters now applied.
struct TaskFilterPresetButton: View {
    let preset: TaskFilterPreset
    let isActive: Bool
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: action) {
            // Icon and text spelled out: a `Label` inside a form row takes the
            // row's label style and drew icon-only capsules at odd heights.
            HStack(spacing: Tokens.Space.tight) {
                Image(systemName: preset.symbol)
                    .accessibilityHidden(true)
                Text(TasksCopy.presetLabel(preset))
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            }
            // One line at regular sizes; at accessibility sizes the pills
            // stack full width (TaskFilterSheet) and the label may wrap.
            .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
            .font(Tokens.Typography.label.font)
            .foregroundStyle(isActive ? Tokens.Interaction.actionForeground.color : Tokens.Text.primary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(
                isActive ? Tokens.Interaction.actionFill.color : Tokens.Canvas.surface.color,
                in: .capsule
            )
            .overlay(Capsule().stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline))
            .contentShape(.capsule)
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
