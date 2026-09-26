import MemryCore
import SwiftUI

// Spec 007 CL061/CL071 (artboard 28). Google Calendar: the accounts with
// this iPhone's state (connected here, needs a sign-in here, reconnect), Add
// account, the imported calendars with their sync state and switches, the
// push and AI switches (synced, D3a), Disconnect. Signing in runs on this
// iPhone (artboard 24's sheet), then the default picker (25).

struct CalendarGoogleScreen: View {
    @Bindable var store: CalendarStore
    @State private var push = true
    @State private var aiConsent = false
    @State private var connecting = false
    @State private var failure: String?
    @State private var pickingDefault = false
    @State private var disconnecting: String?

    private var calendars: [CalendarSourceRecord] {
        store.sources.filter { $0.provider == "google" && $0.kind == "calendar" }
    }

    var body: some View {
        List {
            Section(CalendarCopy.accounts) {
                ForEach(store.googleAccounts, id: \.id) { account in
                    let email = account.accountId ?? account.title
                    let held = store.holdsGoogle(email)
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(email)
                            Text(held ? CalendarCopy.googleConnected : CalendarCopy.googleSignInHere)
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(held ? Tokens.Task.complete.color : Tokens.Task.dueToday.color)
                        }
                        Spacer()
                        Button(held ? CalendarCopy.syncNow : CalendarCopy.reconnect) {
                            Task { held ? await store.sync() : await connect() }
                        }
                        .font(Tokens.Typography.supporting.font.weight(held ? .regular : .semibold))
                        .foregroundStyle(Tokens.Text.tint.color)
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("calendar.google.account.\(email)")
                    }
                }
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        Text(CalendarCopy.addAccount).foregroundStyle(Tokens.Text.tint.color)
                        if connecting { Spacer(); ProgressView() }
                    }
                }
                .disabled(connecting)
                .accessibilityIdentifier("calendar.google.add")
                if let failure {
                    Text(CalendarCopy.googleFailure(failure))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Interaction.destructive.color)
                        .accessibilityIdentifier("calendar.google.error")
                }
            }
            if !calendars.isEmpty {
                Section {
                    ForEach(calendars, id: \.id) { source in
                        Toggle(isOn: Binding(
                            get: { source.isSelected },
                            set: { on in Task { _ = await store.write { try $0.setSourceSelected(sourceId: source.id, selected: on) } } }
                        )) {
                            HStack(spacing: Tokens.Space.medium) {
                                Circle().fill(source.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color)
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(source.title)
                                    Text(status(source))
                                        .font(Tokens.Typography.caption.font)
                                        .foregroundStyle(source.syncStatus == "error" ? Tokens.Interaction.destructive.color : Tokens.Text.secondary.color)
                                }
                            }
                        }
                        .disabled(source.isMemryManaged)
                    }
                } header: {
                    Text(CalendarCopy.importedCalendarsHeader(calendars.filter(\.isSelected).count))
                }
            }
            if !store.googleAccounts.isEmpty {
                Section {
                    Toggle(CalendarCopy.showInGoogle, isOn: $push)
                        .onChange(of: push) { _, on in Task { await save("calendar.google.pushEventsToGoogle", on) } }
                    Toggle(CalendarCopy.aiReadsGoogle, isOn: $aiConsent)
                        .onChange(of: aiConsent) { _, on in Task { await save("calendar.google.agentReadEventsConsent", on) } }
                } footer: {
                    Text(CalendarCopy.syncedSettingFooter)
                }
                Section {
                    Button(CalendarCopy.disconnectGoogle, role: .destructive) {
                        disconnecting = store.googleAccounts.first?.accountId
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("calendar.google.disconnect")
                }
            }
        }
        .tint(Tokens.Tint.base.color)
        .navigationTitle(CalendarCopy.googleTitle)
        .navigationBarTitleDisplayMode(.large)
        .refreshable { await store.sync() }
        .task { await load() }
        .sheet(isPresented: $pickingDefault) { CalendarDefaultPickerSheet(store: store) }
        .alert(CalendarCopy.disconnectGoogleConfirm, isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } })) {
            Button(CalendarCopy.disconnect, role: .destructive) {
                if let email = disconnecting { Task { await store.disconnectGoogle(email) } }
            }
            Button(CalendarCopy.cancel, role: .cancel) {}
        }
    }

    private func status(_ source: CalendarSourceRecord) -> String {
        if source.syncStatus == "error" { return CalendarCopy.syncErrorRetry }
        if !source.isSelected { return CalendarCopy.idle }
        return CalendarCopy.synced
    }

    private func connect() async {
        connecting = true
        defer { connecting = false }
        failure = nil
        switch await store.connectGoogle() {
        case .connected: pickingDefault = await store.googleOnboardingPending()
        case .cancelled: break
        case let .failed(code): failure = code
        }
    }

    private func load() async {
        let core = store.core
        let values = await store.read {
            (try core.setting(path: "calendar.google.pushEventsToGoogle"), try core.setting(path: "calendar.google.agentReadEventsConsent"))
        }
        push = values?.0 != "false"
        aiConsent = values?.1 == "true"
    }

    private func save(_ path: String, _ on: Bool) async {
        _ = await store.write { try $0.setSetting(path: path, valueJson: on ? "true" : "false") }
    }
}

extension CalendarStore {
    /// One provider holds the default (`write-routing.ts`); a Google choice
    /// also lands in Google's own key, as desktop's picker writes it.
    func setDefaultTarget(_ source: CalendarSourceRecord?) async {
        let target = source.map { "{\"provider\":\"\($0.provider)\",\"remoteCalendarId\":\(CalendarDefaultTarget.json($0.remoteId))}" } ?? "null"
        _ = await write { try $0.setSetting(path: "calendar.defaultWriteTarget", valueJson: target) }
        if source?.provider == "google" || source == nil {
            let google = source.map { CalendarDefaultTarget.json($0.remoteId) } ?? "null"
            _ = await write { try $0.setSetting(path: "calendar.google.defaultTargetCalendarId", valueJson: google) }
        }
    }
}

extension CalendarCopy {
    static let googleTitle = "Google Calendar"
    static let googleConnected = "Connected"
    static let googleSignInHere = "Sign in on this iPhone"
    static let reconnect = "Reconnect"
    static let addAccount = "Add account"
    static let showInGoogle = "Show memrynote events in Google"
    static let aiReadsGoogle = "Let AI read Google events"
    static let disconnectGoogle = "Disconnect Google Calendar"
    static let disconnectGoogleConfirm = "Disconnect Google Calendar? Its events leave memrynote on every device."
    static let synced = "Synced"
    static let idle = "Idle"
    static let syncErrorRetry = "Error · Retry now"
    static let pickDefaultTitle = "Where should new events go?"
    static let useCalendar = "Use this calendar"
    static let skip = "Skip"
    static func importedCalendarsHeader(_ selected: Int) -> String { "Imported calendars · \(selected) selected" }

    static func googleFailure(_ code: String) -> String {
        switch code {
        case "scope_not_granted": "Google didn't allow calendar access. Try again and tick the calendar box."
        case "not_configured": "Google sign-in isn't set up in this build."
        case "no_refresh_token": "Google didn't grant lasting access. Remove memrynote in your Google account's security settings, then try again."
        default: "Could not connect Google Calendar. Try again."
        }
    }
}
