import SwiftUI

// TP042. The autocomplete list under the quick-add field for `+project`,
// `#tag` and `[[note` (desktop's `AutocompleteDropdown`). Touch has no arrow
// keys, so the list is a wrapping row of tappable chips instead of a
// highlighted dropdown.

/// One entry the list offers.
struct QuickAddOption: Identifiable, Equatable {
    enum Kind: Equatable { case project, tag, noteLink }

    let id: String
    let label: String
    let kind: Kind
    /// A project's colour.
    let color: String?
}

/// The wrapping list of options for the trigger at the caret.
struct QuickAddSuggestions: View {
    let options: [QuickAddOption]
    let onPick: (QuickAddOption) -> Void

    var body: some View {
        if !options.isEmpty {
            FlowLayout(spacing: Tokens.Space.small) {
                ForEach(options) { option in
                    Button { onPick(option) } label: {
                        Chip(text: text(option), color: color(option), symbol: symbol(option))
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibility(option))
                    .accessibilityIdentifier("tasks.quickAdd.suggestion.\(option.label)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(TasksCopy.quickAddSuggestions)
        }
    }

    private func text(_ option: QuickAddOption) -> String {
        switch option.kind {
        case .project: option.label
        case .tag: "#\(option.label)"
        case .noteLink: option.label
        }
    }

    private func symbol(_ option: QuickAddOption) -> String? {
        option.kind == .noteLink ? "[[" : nil
    }

    private func color(_ option: QuickAddOption) -> Color {
        switch option.kind {
        case .project: Tokens.Palette.color(option.color)
        case .tag: Tokens.Task.tokenTag.color
        case .noteLink: Tokens.Task.tokenNote.color
        }
    }

    private func accessibility(_ option: QuickAddOption) -> String {
        switch option.kind {
        case .project: TasksCopy.quickAddPickProject(option.label)
        case .tag: TasksCopy.quickAddPickTag(option.label)
        case .noteLink: TasksCopy.quickAddPickNote(option.label)
        }
    }
}
