import MemryCore
import SwiftUI
import UIKit

// Spec 007 CL061/CL062/CL064 (artboards 28-31). One page per provider: its
// accounts and calendars as synced here, with the switches that act on the
// synced source rows. Connecting an account runs on this iPhone (goal D3).

struct CalendarProviderScreen: View {
    @Bindable var store: CalendarStore
    let provider: String
    var account: AccountModel?

    var body: some View {
        switch provider {
        case "apple-eventkit": CalendarEventKitScreen(store: store)
        case "ics": CalendarFeedsScreen(store: store)
        case "caldav": CalendarCaldavScreen(store: store, account: account)
        case "google": CalendarGoogleScreen(store: store)
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

/// Artboard 31: This iPhone's permission states and per-calendar switches,
/// grouped by the account iOS holds them under.
struct CalendarEventKitScreen: View {
    @Bindable var store: CalendarStore
    @State private var eventKit = CalendarEventKitStore.shared
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                    Text(CalendarCopy.eventKitExplainer)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .fixedSize(horizontal: false, vertical: true)
                    switch eventKit.access {
                    case .notDetermined:
                        Button {
                            Task {
                                await eventKit.requestAccess()
                                eventKit.reloadCalendars(synced: store.sources)
                                await store.refreshAllWindows()
                            }
                        } label: {
                            Text(CalendarCopy.eventKitAllow)
                                .font(Tokens.Typography.body.font.weight(.semibold))
                                .foregroundStyle(Tokens.Tint.foreground.color)
                                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Tokens.Tint.base.color)
                        .accessibilityIdentifier("calendar.eventkit.allow")
                        Text(CalendarCopy.eventKitAsksOnce)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    case .denied, .restricted, .writeOnly:
                        VStack(alignment: .leading, spacing: Tokens.Space.small) {
                            Text(body(for: eventKit.access))
                                .font(Tokens.Typography.supporting.font)
                                .foregroundStyle(Tokens.Interaction.destructive.color)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: Tokens.Space.inset) {
                                if eventKit.access != .restricted {
                                    Button(CalendarCopy.openSettings) {
                                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                                    }
                                    .accessibilityIdentifier("calendar.eventkit.openSettings")
                                }
                                Button(CalendarCopy.checkAgain) {
                                    eventKit.refreshAccess()
                                    eventKit.reloadCalendars(synced: store.sources)
                                }
                                .accessibilityIdentifier("calendar.eventkit.checkAgain")
                            }
                            .font(Tokens.Typography.supporting.font.weight(.semibold))
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                            .buttonStyle(.plain)
                        }
                        .padding(Tokens.Space.medium)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Tokens.Interaction.destructive.color.opacity(0.08), in: RoundedRectangle(cornerRadius: Tokens.Radius.container))
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("calendar.eventkit.denied")
                    case .allowed:
                        EmptyView()
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.inset, bottom: 0, trailing: Tokens.Space.inset))
            }
            if eventKit.access == .allowed {
                Section {
                    Toggle(CalendarCopy.eventKitShow, isOn: Binding(
                        get: { eventKit.isEnabled },
                        set: { eventKit.isEnabled = $0; Task { await store.refreshAllWindows() } }
                    ))
                    .accessibilityIdentifier("calendar.eventkit.enabled")
                }
                ForEach(groups, id: \.self) { group in
                    Section(group) {
                        ForEach(eventKit.calendars.filter { $0.source == group }) { calendar in
                            Toggle(isOn: Binding(
                                get: { calendar.isOn },
                                set: { eventKit.set(calendar.id, on: $0); Task { await store.refreshAllWindows() } }
                            )) {
                                HStack(spacing: Tokens.Space.medium) {
                                    Circle()
                                        .fill(calendar.colorHex.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color)
                                        .frame(width: 8, height: 8)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(calendar.title)
                                        if calendar.isDuplicate {
                                            Text(CalendarCopy.eventKitDuplicate)
                                                .font(Tokens.Typography.caption.font)
                                                .foregroundStyle(Tokens.Text.secondary.color)
                                        }
                                    }
                                }
                            }
                            .disabled(!eventKit.isEnabled)
                            .accessibilityIdentifier("calendar.eventkit.calendar.\(calendar.title)")
                        }
                    }
                }
            }
        }
        .tint(Tokens.Tint.base.color)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .navigationTitle(CalendarCopy.thisIPhone)
        .navigationBarTitleDisplayMode(.large)
        .onAppear { eventKit.refreshAccess(); eventKit.reloadCalendars(synced: store.sources) }
    }

    private var groups: [String] {
        var seen: [String] = []
        for calendar in eventKit.calendars where !seen.contains(calendar.source) { seen.append(calendar.source) }
        return seen
    }

    private func body(for access: CalendarEventKitStore.Access) -> String {
        switch access {
        case .writeOnly: CalendarCopy.eventKitWriteOnlyBody
        case .restricted: CalendarCopy.eventKitRestrictedBody
        default: CalendarCopy.eventKitDeniedBody
        }
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

    static let eventKitExplainer = "Shows every calendar the Calendar app already has on this iPhone: iCloud, Google, Exchange. No sign-in, read-only, and the events never leave this iPhone."
    static let eventKitAllow = "Allow calendar access"
    static let eventKitAsksOnce = "iOS asks once. You can change it later in Settings."
    static let eventKitRestrictedBody = "Calendar access is restricted on this iPhone (Screen Time or a device profile), so memrynote can't read its calendars."
    static let eventKitShow = "Show This iPhone's calendars"
    static let eventKitDeniedBody = "Calendar access is off for memrynote. Turn it on in Settings › Privacy & Security › Calendars, then check again."
    static let eventKitWriteOnlyBody = "memrynote can add events but not read them. Choose Full Access in Settings › Privacy & Security › Calendars, then check again."
    static let openSettings = "Open Settings"
    static let checkAgain = "Check again"
    static let eventKitDuplicate = "Already connected in memrynote, so it starts off to avoid doubles."
}
