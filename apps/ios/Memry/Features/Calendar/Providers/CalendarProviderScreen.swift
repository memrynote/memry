import MemryCore
import SwiftUI

// Spec 007 CL061/CL062/CL064 (artboards 28-31). One page per provider: its
// accounts and calendars as synced here, with the switches that act on the
// synced source rows. Connecting an account runs on this iPhone (goal D3).

struct CalendarProviderScreen: View {
    @Bindable var store: CalendarStore
    let provider: String

    var body: some View {
        switch provider {
        case "apple-eventkit": CalendarEventKitScreen(store: store)
        default: CalendarSyncedProviderScreen(store: store, provider: provider)
        }
    }
}

/// Google, CalDAV and Subscribed: accounts, calendars with sync status, the
/// push and AI switches (synced settings, D3a).
struct CalendarSyncedProviderScreen: View {
    @Bindable var store: CalendarStore
    let provider: String
    @State private var push = true
    @State private var aiConsent = false

    var body: some View {
        List {
            let accounts = store.sources.filter { $0.provider == provider && $0.kind == "account" }
            let calendars = store.sources.filter { $0.provider == provider && $0.kind == "calendar" }
            if accounts.isEmpty && calendars.isEmpty {
                Section { Text(CalendarCopy.notConnected).foregroundStyle(Tokens.Text.tertiary.color) }
            }
            if !accounts.isEmpty {
                Section(CalendarCopy.accounts) {
                    ForEach(accounts, id: \.id) { account in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.title)
                            Text(CalendarProviderStatus.text(account))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                    }
                }
            }
            if !calendars.isEmpty {
                Section(CalendarCopy.providerCalendars(provider)) {
                    ForEach(calendars, id: \.id) { source in
                        Toggle(isOn: Binding(
                            get: { source.isSelected },
                            set: { on in Task { await store.write { try $0.setSourceSelected(sourceId: source.id, selected: on) } } }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(source.title)
                                Text(CalendarProviderStatus.text(source))
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(source.syncStatus == "error" ? Tokens.Interaction.destructive.color : Tokens.Text.secondary.color)
                            }
                        }
                        .disabled(source.isMemryManaged)
                        .accessibilityIdentifier("calendar.provider.source.\(source.id)")
                    }
                }
            }
            if provider != "ics" {
                Section {
                    Toggle(CalendarCopy.pushToProvider(provider), isOn: $push)
                        .onChange(of: push) { _, on in Task { await save(pushPath, on ? "true" : "false") } }
                    Toggle(CalendarCopy.aiReads, isOn: $aiConsent)
                        .onChange(of: aiConsent) { _, on in Task { await save("calendar.\(provider).agentReadEventsConsent", on ? "true" : "false") } }
                } footer: {
                    Text(CalendarCopy.syncedSettingFooter)
                }
            }
        }
        .navigationTitle(CalendarProvider.named(provider).title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.sync() }
        .task { await load() }
    }

    private var pushPath: String {
        provider == "google" ? "calendar.google.pushEventsToGoogle" : "calendar.\(provider).pushEventsToProvider"
    }

    private func load() async {
        let core = store.core
        let path = pushPath
        let provider = provider
        let values = await store.read {
            (try core.setting(path: path), try core.setting(path: "calendar.\(provider).agentReadEventsConsent"))
        }
        push = values?.0 != "false"
        aiConsent = values?.1 == "true"
    }

    private func save(_ path: String, _ json: String) async {
        await store.write { try $0.setSetting(path: path, valueJson: json) }
    }
}

enum CalendarProviderStatus {
    static func text(_ source: CalendarSourceRecord) -> String {
        if source.syncStatus == "error" {
            return source.lastError.map(CalendarCopy.feedError) ?? CalendarCopy.syncError
        }
        guard let last = source.lastSyncedAt.flatMap(CalendarDates.date) else { return CalendarCopy.notSyncedYet }
        return CalendarCopy.updated(last.formatted(.relative(presentation: .named)))
    }
}

/// Artboard 31: This iPhone's permission states and per-calendar switches.
struct CalendarEventKitScreen: View {
    @Bindable var store: CalendarStore
    @State private var eventKit = CalendarEventKitStore.shared
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section { Text(CalendarCopy.eventKitExplainer).font(Tokens.Typography.supporting.font) }
            switch eventKit.access {
            case .notDetermined:
                Section { Button(CalendarCopy.eventKitAllow) { Task { await eventKit.requestAccess(); eventKit.reloadCalendars(synced: store.sources); await store.refreshAllWindows() } } }
            case .denied, .restricted, .writeOnly:
                Section {
                    Text(eventKit.access == .writeOnly ? CalendarCopy.eventKitWriteOnlyBody : CalendarCopy.eventKitDeniedBody)
                    Button(CalendarCopy.openSettings) {
                        if let url = URL(string: "app-settings:") { openURL(url) }
                    }
                    Button(CalendarCopy.checkAgain) { eventKit.refreshAccess(); eventKit.reloadCalendars(synced: store.sources) }
                }
            case .allowed:
                Section {
                    Toggle(CalendarCopy.eventKitShow, isOn: Binding(get: { eventKit.isEnabled }, set: { eventKit.isEnabled = $0; Task { await store.refreshAllWindows() } }))
                }
                Section(CalendarCopy.providerCalendars("apple-eventkit")) {
                    ForEach(eventKit.calendars) { calendar in
                        Toggle(isOn: Binding(get: { calendar.isOn }, set: { eventKit.set(calendar.id, on: $0); Task { await store.refreshAllWindows() } })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(calendar.title)
                                Text(calendar.isDuplicate ? CalendarCopy.eventKitDuplicate : calendar.source)
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                            }
                        }
                    }
                }
            }
            Section { Text(CalendarCopy.eventKitNeverSynced).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color) }
        }
        .navigationTitle(CalendarCopy.thisIPhone)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { eventKit.refreshAccess(); eventKit.reloadCalendars(synced: store.sources) }
    }
}

extension CalendarCopy {
    static func pushToProvider(_ provider: String) -> String {
        provider == "google" ? "Push memrynote events to Google" : "Push memrynote events to this calendar"
    }
    static let aiReads = "Let AI read these events"
    static let syncedSettingFooter = "These choices sync with your other devices."
    static let syncError = "Couldn't sync"
    static let notSyncedYet = "Not synced yet"
    static func updated(_ when: String) -> String { "Updated \(when)" }

    /// `settings.json` `subscriptions.errors.*`.
    static func feedError(_ code: String) -> String {
        switch code {
        case "invalid_url": "That link isn't a valid calendar address."
        case "unreachable": "Couldn't reach the calendar. Check the link or your connection."
        case "timeout": "The calendar took too long to respond."
        case "not_found": "No calendar was found at that link."
        case "unauthorized": "The calendar needs a password or is private."
        case "too_large": "The calendar is too large to import."
        case "not_a_calendar": "That link doesn't point to a calendar."
        case "too_many_redirects": "The link redirected too many times."
        case "unsupported_redirect": "The link redirected somewhere memrynote can't follow."
        default: "Couldn't update (\(code))."
        }
    }

    static let eventKitExplainer = "Show the calendars on this iPhone beside your memrynote items. They stay on this iPhone and are never synced."
    static let eventKitAllow = "Allow access to calendars"
    static let eventKitShow = "Show This iPhone's calendars"
    static let eventKitDeniedBody = "Memry can't read this iPhone's calendars. Turn on full access in Settings."
    static let eventKitWriteOnlyBody = "Memry can add to your calendars but not read them. Turn on full access in Settings."
    static let openSettings = "Open Settings"
    static let checkAgain = "Check again"
    static let eventKitDuplicate = "Already connected through another account · off"
    static let eventKitNeverSynced = "Events from This iPhone never leave this device."
}
