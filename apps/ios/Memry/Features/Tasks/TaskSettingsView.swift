import MemryCore
import SwiftUI

// TP055. Settings > Tasks, after desktop's `pages/settings/tasks-section.tsx`:
// default project, default sort order, default view, stale inbox threshold.
// Each change is one core write (`TaskSettingsActions.swift`); the screen
// shows what the core answered, never its own guess.

/// TP055 — Settings > Tasks.
struct TaskSettingsView: View {
    let store: TasksStore

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
                    TaskSettingsProjectPicker(store: store, selected: settings.defaultProjectId)
                    TaskSettingsSortPicker(store: store, selected: settings.defaultSortOrder)
                    TaskSettingsViewPicker(store: store, selected: settings.defaultView)
                } header: {
                    Text(TasksCopy.settingsDefaultsGroup)
                }
                Section {
                    TaskSettingsStaleInboxRow(store: store, stored: Int(settings.staleInboxDays))
                } header: {
                    Text(TasksCopy.settingsInboxGroup)
                } footer: {
                    Text(TasksCopy.settingsDeviceFootnote)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .accessibilityIdentifier("tasks.settings.deviceFootnote")
                }
            } else {
                ProgressView(TasksCopy.settingsLoading)
            }
        }
        .accessibilityIdentifier("tasks.settings.screen")
        .navigationTitle(TasksCopy.settingsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.loadTaskSettings() }
    }
}

/// A setting's name with desktop's one-line description under it.
struct TaskSettingsLabel: View {
    let title: String
    let help: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(help)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Default project: "no default" or one of the live projects.
struct TaskSettingsProjectPicker: View {
    let store: TasksStore
    let selected: String?

    var body: some View {
        Picker(selection: selection) {
            Text(TasksCopy.settingsNoDefaultProject(inbox: store.projects.first { $0.isInbox }?.name))
                .tag(String?.none)
            ForEach(options, id: \.id) { project in
                Label {
                    Text(label(for: project))
                } icon: {
                    Image(systemName: "circle.fill")
                        .foregroundStyle(Tokens.Palette.color(project.color))
                        .accessibilityHidden(true)
                }
                .tag(Optional(project.id))
            }
            if let selected, store.project(selected) == nil {
                // A default another device deleted: still selectable here, so
                // the picker names what is stored instead of showing nothing.
                Text(TasksCopy.settingsMissingProject).tag(Optional(selected))
            }
        } label: {
            TaskSettingsLabel(title: TasksCopy.settingsDefaultProject, help: TasksCopy.settingsDefaultProjectHelp)
        }
        .pickerStyle(.navigationLink)
        .accessibilityIdentifier("tasks.settings.defaultProject")
    }

    /// Desktop offers the unarchived projects; the stored default is kept in
    /// the list even when it has been archived since.
    private var options: [ProjectItem] {
        store.projects.filter { $0.archivedAt == nil || $0.id == selected }
    }

    private func label(for project: ProjectItem) -> String {
        project.archivedAt == nil ? project.name : TasksCopy.settingsArchivedProject(project.name)
    }

    private var selection: Binding<String?> {
        Binding(
            get: { selected },
            set: { value in
                guard value != selected else { return }
                Task { await store.setDefaultProject(value) }
            }
        )
    }
}

/// Default sort order: desktop's four choices.
struct TaskSettingsSortPicker: View {
    let store: TasksStore
    let selected: String

    var body: some View {
        Picker(selection: selection) {
            ForEach(TaskSettingsSortOrder.allCases) { order in
                Text(TasksCopy.settingsSortOrderLabel(order)).tag(order.rawValue)
            }
        } label: {
            TaskSettingsLabel(title: TasksCopy.settingsSortOrder, help: TasksCopy.settingsSortOrderHelp)
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("tasks.settings.defaultSort")
    }

    private var selection: Binding<String> {
        Binding(
            get: { selected },
            set: { value in
                guard value != selected, let order = TaskSettingsSortOrder(rawValue: value) else { return }
                Task { await store.setDefaultSortOrder(order) }
            }
        )
    }
}

/// Default view: which tab the Tasks page opens on. Local to this device.
struct TaskSettingsViewPicker: View {
    let store: TasksStore
    let selected: String

    var body: some View {
        Picker(selection: selection) {
            ForEach(TaskSettingsDefaultView.allCases) { view in
                Text(TasksCopy.tabTitle(view.tab)).tag(view.rawValue)
            }
        } label: {
            TaskSettingsLabel(title: TasksCopy.settingsDefaultView, help: TasksCopy.settingsDefaultViewHelp)
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("tasks.settings.defaultView")
    }

    private var selection: Binding<String> {
        Binding(
            get: { selected },
            set: { value in
                guard value != selected, let view = TaskSettingsDefaultView(rawValue: value) else { return }
                Task { await store.setDefaultView(view) }
            }
        )
    }
}

/// Stale inbox threshold, 1 to 90 days. Steps are held briefly and written
/// once, so a run of taps is one core write and one sync, not one per tap.
struct TaskSettingsStaleInboxRow: View {
    let store: TasksStore
    let stored: Int

    /// The stepper's value while a write is pending; `nil` shows `stored`.
    @State private var draft: Int?

    var body: some View {
        Stepper(value: value, in: TaskSettingsLimits.staleInboxDays) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                TaskSettingsLabel(title: TasksCopy.settingsStaleInbox, help: TasksCopy.settingsStaleInboxHelp)
                Text(TasksCopy.settingsStaleInboxValue(value.wrappedValue))
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .monospacedDigit()
            }
        }
        .accessibilityValue(TasksCopy.settingsStaleInboxValue(value.wrappedValue))
        .accessibilityIdentifier("tasks.settings.staleInboxDays")
        .task(id: draft) { await commit() }
    }

    private var value: Binding<Int> {
        Binding(get: { draft ?? stored }, set: { draft = $0 })
    }

    private func commit() async {
        guard let days = draft, days != stored else { return }
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        await store.setStaleInboxDays(days)
        // Written or refused, the row now shows what the core holds.
        if !Task.isCancelled { draft = nil }
    }
}
