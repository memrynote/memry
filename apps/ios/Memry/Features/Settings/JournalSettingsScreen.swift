import MemryCore
import SwiftUI

// Spec 006 ST50 / ST51, artboards 15–17. The default template and the seven
// per-day templates are synced (one clock per day); Day page toggles, folder
// and date format are this iPhone's (F2). Behind the Journal gate (F9).
struct JournalSettingsScreen: View {
    let context: SettingsContext
    @State private var local = LocalSettings.shared
    @State private var templates: [TemplateItem] = []

    var body: some View {
        List {
            if let failure = context.store.failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section {
                Picker(selection: defaultTemplate) {
                    Text(JournalCopy.none).tag(String?.none)
                    ForEach(templates, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                    if let id = context.store.journal.defaultTemplate, !templates.contains(where: { $0.id == id }) {
                        Text(JournalCopy.missing).tag(Optional(id))
                    }
                } label: {
                    SettingsRowLabel(title: JournalCopy.template)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.journal.template")
                SettingsToggleRow(title: JournalCopy.perDayToggle, isOn: $local.perDayTemplates,
                                  identifier: "settings.journal.perDay")
                if local.perDayTemplates {
                    SettingsLinkRow(title: JournalCopy.perDayTitle, value: JournalCopy.summary(setDays), route: .perDayTemplates)
                }
            } header: {
                Text(JournalCopy.defaultGroup)
            } footer: {
                SettingsFooter(JournalCopy.templateFooter)
            }
            Section {
                SettingsToggleRow(title: JournalCopy.showTasks, isOn: $local.journalShowTasks, identifier: "settings.journal.tasks")
                SettingsToggleRow(title: JournalCopy.showStats, isOn: $local.journalShowStats, identifier: "settings.journal.stats")
            } header: {
                Text(JournalCopy.dayPage)
            } footer: {
                SettingsFooter(JournalCopy.dayPageFooter)
            }
            Section {
                LabeledContent(JournalCopy.folder) {
                    TextField(JournalCopy.folder, text: $local.journalFolder)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                }
                Picker(JournalCopy.dateFormat, selection: $local.journalDateFormat) {
                    ForEach(JournalCopy.dateFormats, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
                LabeledContent(JournalCopy.preview, value: preview)
                    .accessibilityIdentifier("settings.journal.preview")
            } header: {
                Text(JournalCopy.location)
            } footer: {
                SettingsFooter(JournalCopy.locationFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.journal)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if case let .success(list) = await context.read({ try $0.templateList() }) { templates = list }
        }
    }

    private var setDays: Int { context.store.journal.weekdayTemplates.compactMap(\.self).count }

    private var preview: String {
        let format = local.journalDateFormat
            .replacingOccurrences(of: "YYYY", with: "yyyy")
            .replacingOccurrences(of: "DD", with: "dd")
        let formatter = DateFormatter()
        formatter.dateFormat = format
        return "\(local.journalFolder)/\(formatter.string(from: .now)).md"
    }

    private var defaultTemplate: Binding<String?> {
        Binding(get: { context.store.journal.defaultTemplate },
                set: { id in Task { await context.store.setDefaultTemplate(id) } })
    }
}

/// Artboard 17: one menu per day (Monday first), "N of 7 set", Clear all.
struct PerDayTemplatesScreen: View {
    let context: SettingsContext
    @State private var templates: [TemplateItem] = []
    /// JS `getDay()` order is Sunday = 0; the page lists Monday first.
    private let order = [1, 2, 3, 4, 5, 6, 0]

    var body: some View {
        List {
            Section {
                ForEach(order, id: \.self) { day in
                    Picker(selection: binding(day)) {
                        Text(JournalCopy.inherit(defaultName)).tag(String?.none)
                        ForEach(templates, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                        if let id = context.store.journal.weekdayTemplates[day], !templates.contains(where: { $0.id == id }) {
                            Text(JournalCopy.missing).tag(Optional(id))
                        }
                    } label: {
                        SettingsRowLabel(title: Calendar(identifier: .gregorian).weekdaySymbols[day])
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("settings.perDay.\(day)")
                }
            } header: {
                Text(JournalCopy.summary(context.store.journal.weekdayTemplates.compactMap(\.self).count))
            } footer: {
                SettingsFooter(JournalCopy.perDayFooter)
            }
            Section {
                SettingsDestructiveRow(title: JournalCopy.clearAll, identifier: "settings.perDay.clear") {
                    Task {
                        for day in 0 ..< 7 where context.store.journal.weekdayTemplates[day] != nil {
                            await context.store.setWeekdayTemplate(day: day, nil)
                        }
                    }
                }
            }
        }
        .settingsList()
        .navigationTitle(JournalCopy.perDayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if case let .success(list) = await context.read({ try $0.templateList() }) { templates = list }
        }
    }

    private var defaultName: String? {
        guard let id = context.store.journal.defaultTemplate else { return nil }
        return templates.first { $0.id == id }?.name ?? JournalCopy.missing
    }

    private func binding(_ day: Int) -> Binding<String?> {
        Binding(get: { context.store.journal.weekdayTemplates[day] },
                set: { id in Task { await context.store.setWeekdayTemplate(day: day, id) } })
    }
}

/// Desktop `settings.json` `journal.*` wording.
enum JournalCopy {
    static let defaultGroup = "Default Template"
    static let template = "Template"
    static let none = "None (ask each time)"
    static let missing = "Deleted template"
    static let perDayToggle = "Use a different template per day"
    static let perDayTitle = "Per-Day Templates"
    static func summary(_ count: Int) -> String { "\(count) of 7 set" }
    static let templateFooter = "New entries start with this template. Shared with your other devices."
    static let dayPage = "Day page"
    static let showTasks = "Show Tasks"
    static let showStats = "Show Stats Footer"
    static let dayPageFooter = "This iPhone. Tasks due that day appear under the entry."
    static let location = "Location & Format"
    static let folder = "Journal Folder"
    static let dateFormat = "Date Format"
    static let dateFormats = ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY", "YYYY/MM/DD"]
    static let preview = "Preview"
    static let locationFooter = "This iPhone. Changing it does not move existing entries."
    static func inherit(_ name: String?) -> String { name.map { "Default · \($0)" } ?? "Default · none" }
    static let perDayFooter = "A day set to Default uses the Journal template. A deleted template shows as “Deleted template” and falls back to Default. Shared with your other devices."
    static let clearAll = "Clear all"
}
