import MemryCore
import SwiftUI

// Spec 006 ST40 / ST41, artboards 09 / 09b / 10. Language is synced (F5) and
// takes effect at the next launch; everything else here is this iPhone's
// (§5.2): time and date format with a live example, week start, the new-notes
// folder, spell check and usage metrics. The diagnostic report (11) is not
// offered: iOS has no report channel (§7).
struct GeneralScreen: View {
    let context: SettingsContext
    @State private var local = LocalSettings.shared

    var body: some View {
        List {
            if let failure = context.store.failure {
                Section { ErrorNotice(error: failure, code: nil) }
            }
            Section {
                Picker(SettingsCopy.language, selection: language) {
                    ForEach(Languages.all, id: \.self) { code in
                        Text(Languages.name(code)).tag(code)
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("settings.general.language")
            } footer: {
                SettingsFooter(SettingsCopy.languageFooter)
            }
            Section(SettingsCopy.dateAndTime) {
                Picker(selection: $local.clockFormat) {
                    ForEach(ClockFormat.allCases) { format in
                        Text(DateExamples.clockLabel(format)).tag(format)
                    }
                } label: {
                    SettingsRowLabel(title: SettingsCopy.timeFormat)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.general.clock")
                Picker(selection: $local.dateFormat) {
                    ForEach(DateFormatChoice.allCases) { format in
                        Text(DateExamples.date(format)).tag(format)
                    }
                } label: {
                    SettingsRowLabel(title: SettingsCopy.dateFormat)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.general.date")
                Picker(SettingsCopy.weekStarts, selection: $local.weekStart) {
                    Text(SettingsCopy.sunday).tag(WeekStart.sunday)
                    Text(SettingsCopy.monday).tag(WeekStart.monday)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.general.weekStart")
            }
            Section {
                SettingsLinkRow(title: SettingsCopy.newNotesGoTo, value: local.newNotesFolder ?? SettingsCopy.vaultRoot,
                                route: .newNotesFolder)
                SettingsToggleRow(title: SettingsCopy.checkSpelling, isOn: $local.spellCheck,
                                  identifier: "settings.general.spell")
            } header: {
                Text(SettingsCopy.editing)
            } footer: {
                SettingsFooter(SettingsCopy.newNotesFooter)
            }
            Section {
                SettingsToggleRow(title: SettingsCopy.usageMetrics, isOn: $local.usageMetrics,
                                  identifier: "settings.general.metrics")
            } header: {
                Text(SettingsCopy.privacy)
            } footer: {
                SettingsFooter(SettingsCopy.privacyFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.general)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var language: Binding<String> {
        Binding(
            get: { context.store.language },
            set: { code in Task { await context.store.setLanguage(code) } }
        )
    }
}

/// Artboard 10: the vault's folders, a check on the current one.
struct NewNotesFolderScreen: View {
    let context: SettingsContext
    @State private var local = LocalSettings.shared
    @State private var folders: [FolderSummary] = []

    var body: some View {
        List {
            Section {
                row(nil, title: SettingsCopy.vaultRoot, depth: 0)
            }
            Section(SettingsCopy.folders) {
                ForEach(folders, id: \.path) { folder in
                    row(folder.path, title: folder.name, depth: folder.path.split(separator: "/").count - 1)
                }
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.newNotesGoTo)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let notes = context.notes
            folders = ((try? await context.executor.run { try notes.folders() }) ?? [])
                .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        }
    }

    private func row(_ path: String?, title: String, depth: Int) -> some View {
        Button {
            local.newNotesFolder = path
        } label: {
            HStack {
                Label(title, systemImage: path == nil ? "tray.full" : "folder")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .padding(.leading, CGFloat(depth) * Tokens.Space.inset)
                Spacer()
                if local.newNotesFolder == path {
                    Image(systemName: "checkmark").foregroundStyle(Tokens.Text.tint.color)
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .accessibilityAddTraits(local.newNotesFolder == path ? .isSelected : [])
    }
}

/// Desktop's language list (`LocaleSchema`), shown in each language's own name.
enum Languages {
    static let all = [
        "ar", "cs", "da", "de", "el", "en", "es", "fi", "fil", "fr", "he", "hr", "hu", "id", "it", "ja",
        "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh-CN", "zh-TW"
    ]

    static func name(_ code: String) -> String {
        let locale = Locale(identifier: code)
        return locale.localizedString(forIdentifier: code)?.capitalized(with: locale) ?? code
    }
}

/// Live examples for the format menus (09b).
enum DateExamples {
    static let sample: Date = {
        let components = DateComponents(year: 2026, month: 9, day: 24, hour: 14, minute: 30)
        return Calendar(identifier: .gregorian).date(from: components) ?? .now
    }()

    static func clockLabel(_ format: ClockFormat) -> String {
        switch format {
        case .system: "\(SettingsCopy.system) · \(sample.formatted(date: .omitted, time: .shortened))"
        case .h12: "\(SettingsCopy.hour12) · 2:30 PM"
        case .h24: "\(SettingsCopy.hour24) · 14:30"
        }
    }

    static func date(_ format: DateFormatChoice) -> String {
        switch format {
        case .system: "\(SettingsCopy.system) · \(sample.formatted(date: .abbreviated, time: .omitted))"
        case .us: "09/24/2026"
        case .eu: "24/09/2026"
        case .iso: "2026-09-24"
        case .dotted: "24.09.2026"
        }
    }
}
