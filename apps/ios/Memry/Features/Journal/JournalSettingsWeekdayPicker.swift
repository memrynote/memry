import MemryCore
import SwiftUI

// JP048. J12: the template of one absolute weekday (0 = Sunday). "Use default"
// writes an explicit `null` (D9); a template writes its id. A tap writes and
// goes back, as the system's navigation-link pickers do.

/// J12 — one weekday's template.
struct JournalSettingsWeekdayPicker: View {
    let store: JournalStore
    let weekday: Int
    let templates: [TemplateSummary]

    @Environment(\.dismiss) private var dismiss

    private var settings: JournalSettingsRecord? { store.settings }

    private var stored: String? {
        settings.flatMap { JournalSettingsRules.stored($0, weekday: weekday) }
    }

    /// The default's name under "Use default", or "None".
    private var defaultName: String {
        settings.map { JournalSettingsRules.defaultLabel($0, templates: templates) }
            ?? JournalCopy.settingsTemplateNone
    }

    var body: some View {
        List {
            Section {
                JournalSettingsChoiceRow(
                    title: JournalCopy.settingsWeekdayInherit,
                    detail: defaultName,
                    isSelected: stored == nil
                ) { choose(nil) }
                    .accessibilityIdentifier("journal.settings.weekdayPicker.inherit")
                ForEach(templates, id: \.id) { template in
                    JournalSettingsChoiceRow(
                        title: template.name,
                        detail: nil,
                        isSelected: stored == template.id
                    ) { choose(template.id) }
                        .accessibilityIdentifier("journal.settings.weekdayPicker.\(template.id)")
                }
                if let stored, JournalSettingsRules.name(of: stored, in: templates) == nil {
                    // Set to a template this vault no longer has: named, and
                    // kept until the user picks another.
                    JournalSettingsChoiceRow(
                        title: JournalCopy.settingsWeekdayMissing,
                        detail: nil,
                        isSelected: true,
                        isMissing: true
                    ) { dismiss() }
                        .accessibilityIdentifier("journal.settings.weekdayPicker.missing")
                }
            } footer: {
                Text(JournalCopy.settingsWeekdayRule(weekday))
            }
        }
        .accessibilityIdentifier("journal.settings.weekdayPicker")
        .navigationTitle(JournalCopy.weekdayName(weekday))
        .navigationBarTitleDisplayMode(.large)
    }

    private func choose(_ templateId: String?) {
        guard templateId != stored else {
            dismiss()
            return
        }
        Task {
            if await store.setWeekdayTemplate(weekday, templateId: templateId) { dismiss() }
        }
    }
}

/// A choice in J12: a title, an optional second line, a checkmark on the
/// current one.
struct JournalSettingsChoiceRow: View {
    let title: String
    let detail: String?
    let isSelected: Bool
    var isMissing = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Space.medium) {
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    Text(title)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(isMissing ? Tokens.Interaction.destructive.color : Tokens.Text.primary.color)
                    if let detail {
                        Text(detail)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
                Spacer(minLength: Tokens.Space.small)
                Image(systemName: "checkmark")
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.tint.color)
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
