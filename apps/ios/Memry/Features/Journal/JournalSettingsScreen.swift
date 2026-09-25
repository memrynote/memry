import MemryCore
import SwiftUI

// JP048. Settings › Journal (J11), after desktop's
// `pages/settings/journal-section.tsx`: the default template, a template per
// weekday, and the stats footer switch. No folder or filename settings (D7).
// Template writes are synced settings through the core (D9); the stats footer
// switch is device-local, per vault.

/// J11 — Settings › Journal.
struct JournalSettingsScreen: View {
    let store: JournalStore

    /// The Tasks tab's week start (0 Sunday, 1 Monday), for row order only.
    @Environment(\.journalTasks) private var tasks
    @State private var templates: [TemplateSummary] = []

    private var weekStartsOn: Int { Int(tasks?.weekStartsOn ?? 1) }

    var body: some View {
        Form {
            if let failure = store.failure {
                Section {
                    ErrorNotice(error: failure, code: nil)
                        .listRowInsets(EdgeInsets())
                }
            }
            if let settings = store.settings {
                Section {
                    JournalSettingsDefaultPicker(store: store, settings: settings, templates: templates)
                } header: {
                    Text(JournalCopy.settingsDefaultTemplate)
                } footer: {
                    Text(JournalCopy.settingsTemplateDescription)
                }
                Section {
                    ForEach(JournalSettingsRules.orderedWeekdays(weekStartsOn: weekStartsOn), id: \.self) { weekday in
                        NavigationLink {
                            JournalSettingsWeekdayPicker(store: store, weekday: weekday, templates: templates)
                        } label: {
                            JournalSettingsWeekdayRow(
                                weekday: weekday,
                                label: JournalSettingsRules.weekdayLabel(
                                    settings, weekday: weekday, templates: templates
                                )
                            )
                        }
                        .accessibilityIdentifier("journal.settings.weekday.\(weekday)")
                    }
                } header: {
                    Text(JournalCopy.settingsWeekdayHeader(JournalSettingsRules.configuredCount(settings)))
                        .accessibilityIdentifier("journal.settings.weekdaySummary")
                }
            } else {
                ProgressView(JournalCopy.settingsLoading)
            }
            JournalSettingsStatsFooterSection(vaultId: store.vaultId)
        }
        .accessibilityIdentifier("journal.settings.screen")
        .navigationTitle(JournalCopy.settingsTitle)
        .navigationBarTitleDisplayMode(.large)
        // A write here or a sync pass bumps the generation: re-read both the
        // settings and the template list.
        .task(id: store.generation) { await reload() }
    }

    private func reload() async {
        await store.loadSettings()
        guard let reader = store.context?.reader else { return }
        do {
            templates = try await reader.templates()
        } catch {
            store.report(error)
        }
    }
}

/// The default template: "None" or one of the vault's templates.
struct JournalSettingsDefaultPicker: View {
    let store: JournalStore
    let settings: JournalSettingsRecord
    let templates: [TemplateSummary]

    private var selected: String? {
        guard let id = settings.defaultTemplate, !id.isEmpty else { return nil }
        return id
    }

    var body: some View {
        Picker(selection: selection) {
            Text(JournalCopy.settingsTemplateNone).tag(String?.none)
            ForEach(templates, id: \.id) { template in
                Text(template.name).tag(Optional(template.id))
            }
            if let selected, JournalSettingsRules.name(of: selected, in: templates) == nil {
                // A default deleted elsewhere (or not on this phone yet): kept
                // selectable so the picker names what is stored.
                Text(JournalCopy.settingsUnknownTemplate).tag(Optional(selected))
            }
        } label: {
            Text(JournalCopy.settingsTemplate)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
        }
        .pickerStyle(.navigationLink)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityValue(JournalSettingsRules.defaultLabel(settings, templates: templates))
        .accessibilityIdentifier("journal.settings.defaultTemplate")
    }

    private var selection: Binding<String?> {
        Binding(
            get: { selected },
            set: { value in
                guard value != selected else { return }
                Task { await store.setDefaultTemplate(value) }
            }
        )
    }
}

/// One weekday row: the day's name and what an entry that day starts from.
struct JournalSettingsWeekdayRow: View {
    let weekday: Int
    let label: JournalWeekdayLabel

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(JournalCopy.weekdayName(weekday))
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.small)
            Text(label.text)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(JournalCopy.settingsWeekdayAccessibility(weekday, value: label.text))
    }

    private var valueColor: Color {
        if label == .missing { return Tokens.Interaction.destructive.color }
        return label.isInherited ? Tokens.Text.tertiary.color : Tokens.Text.secondary.color
    }
}

/// D9: the stats footer switch, device-local per vault, off by default.
struct JournalSettingsStatsFooterSection: View {
    @AppStorage private var showStatsFooter: Bool

    init(vaultId: String) {
        _showStatsFooter = AppStorage(wrappedValue: false, JournalPreferences.statsFooterKey(vaultId: vaultId))
    }

    var body: some View {
        Section {
            Toggle(isOn: $showStatsFooter) {
                Text(JournalCopy.settingsShowStatsFooter)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            .tint(Tokens.Tint.base.color)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityHint(JournalCopy.settingsShowStatsFooterDescription)
            .accessibilityIdentifier("journal.settings.statsFooter")
        } header: {
            Text(JournalCopy.settingsFooterGroup)
        } footer: {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(JournalCopy.settingsShowStatsFooterDescription)
                Text(JournalCopy.settingsStatsFooterDevice)
            }
        }
    }
}
