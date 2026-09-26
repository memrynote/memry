import MemryCore
import SwiftUI

// Spec 007 CL062/CL074 (artboard 30). CalDAV: pick a service (desktop's ten
// presets), username and app password; discovery runs before anything is
// saved. When a device on the account runs a build that predates write
// routing, the notice must be ticked first (desktop `writer-compat.ts`).
// Connected accounts list their calendars with switches, the push and AI
// switches (synced), Sync now and Disconnect.

struct CaldavPreset: Identifiable, Equatable {
    let id: String
    let title: String
    let serverUrl: String?
    let hostTemplate: String?

    /// `@memry/contracts/caldav-presets`.
    static let all = [
        CaldavPreset(id: "icloud", title: "Apple iCloud", serverUrl: "https://caldav.icloud.com/", hostTemplate: nil),
        CaldavPreset(id: "fastmail", title: "Fastmail", serverUrl: "https://caldav.fastmail.com/", hostTemplate: nil),
        CaldavPreset(id: "nextcloud", title: "Nextcloud", serverUrl: nil, hostTemplate: "https://{host}/remote.php/dav/"),
        CaldavPreset(id: "self-hosted", title: "Radicale / Baïkal", serverUrl: nil, hostTemplate: nil),
        CaldavPreset(id: "zoho", title: "Zoho", serverUrl: "https://calendar.zoho.com/", hostTemplate: nil),
        CaldavPreset(id: "yahoo", title: "Yahoo", serverUrl: "https://caldav.calendar.yahoo.com/", hostTemplate: nil),
        CaldavPreset(id: "mailbox-org", title: "mailbox.org", serverUrl: "https://dav.mailbox.org/", hostTemplate: nil),
        CaldavPreset(id: "posteo", title: "Posteo", serverUrl: "https://posteo.de:8443/", hostTemplate: nil),
        CaldavPreset(id: "synology", title: "Synology", serverUrl: nil, hostTemplate: nil),
        CaldavPreset(id: "other", title: "Other (server address)", serverUrl: nil, hostTemplate: nil)
    ]
}

struct CalendarCaldavScreen: View {
    @Bindable var store: CalendarStore
    let account: AccountModel?
    @State private var presetId = "icloud"
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var connecting = false
    @State private var error: String?
    @State private var outdated: [String] = []
    @State private var acknowledged = false
    @State private var push = true
    @State private var aiConsent = false

    private var preset: CaldavPreset { CaldavPreset.all.first { $0.id == presetId } ?? CaldavPreset.all[0] }

    private var serverAddress: String {
        if let url = preset.serverUrl { return url }
        if let template = preset.hostTemplate { return template.replacingOccurrences(of: "{host}", with: server.trimmingCharacters(in: .whitespaces)) }
        return server
    }

    private var canConnect: Bool {
        !connecting && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
            && !serverAddress.trimmingCharacters(in: .whitespaces).isEmpty && (outdated.isEmpty || acknowledged)
    }

    var body: some View {
        List {
            Section {
                Picker(CalendarCopy.caldavService, selection: $presetId) {
                    ForEach(CaldavPreset.all) { Text($0.title).tag($0.id) }
                }
                .tint(Tokens.Text.secondary.color)
                .accessibilityIdentifier("calendar.caldav.preset")
                if preset.serverUrl == nil {
                    LabeledContent(preset.hostTemplate == nil ? CalendarCopy.caldavServer : CalendarCopy.caldavHost) {
                        TextField(preset.hostTemplate == nil ? "https://dav.example.com/" : "cloud.example.com", text: $server)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .multilineTextAlignment(.trailing)
                            .accessibilityIdentifier("calendar.caldav.server")
                    }
                }
                LabeledContent(CalendarCopy.caldavUsername) {
                    TextField(CalendarCopy.caldavUsernamePlaceholder, text: $username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("calendar.caldav.username")
                }
                LabeledContent(CalendarCopy.caldavPassword) {
                    SecureField(CalendarCopy.caldavPasswordPlaceholder, text: $password)
                        .textContentType(.password)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("calendar.caldav.password")
                }
            } footer: {
                Text(CalendarCopy.caldavHelp(preset.id))
            }
            if !outdated.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        Text(CalendarCopy.writerCompatTitle).font(Tokens.Typography.supporting.font.weight(.semibold))
                        Text(CalendarCopy.writerCompatBody(outdated)).font(Tokens.Typography.caption.font)
                        Button { acknowledged.toggle() } label: {
                            Label(CalendarCopy.writerCompatAck, systemImage: acknowledged ? "checkmark.square.fill" : "square")
                                .font(Tokens.Typography.supporting.font)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(acknowledged ? .isSelected : [])
                        .accessibilityIdentifier("calendar.caldav.ack")
                    }
                    .foregroundStyle(Tokens.Task.dueToday.color)
                }
                .listRowBackground(Tokens.Task.dueToday.color.opacity(0.12))
            }
            Section {
                if let error {
                    Text(CalendarCopy.caldavError(error))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Interaction.destructive.color)
                        .accessibilityIdentifier("calendar.caldav.error")
                }
                Button { Task { await connect() } } label: {
                    Group { if connecting { ProgressView() } else { Text(CalendarCopy.caldavConnect) } }
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .foregroundStyle(Tokens.Tint.foreground.color)
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .disabled(!canConnect)
                .accessibilityIdentifier("calendar.caldav.connect")
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.inset, bottom: 0, trailing: Tokens.Space.inset))
            ForEach(store.caldavAccounts, id: \.accountId) { account in
                accountSection(account)
            }
            if !store.caldavAccounts.isEmpty {
                Section {
                    Toggle(CalendarCopy.pushToProvider("caldav"), isOn: $push)
                        .onChange(of: push) { _, on in Task { await save("calendar.caldav.pushEventsToProvider", on) } }
                    Toggle(CalendarCopy.aiReads, isOn: $aiConsent)
                        .onChange(of: aiConsent) { _, on in Task { await save("calendar.caldav.agentReadEventsConsent", on) } }
                    Button {
                        Task { await store.sync() }
                    } label: {
                        HStack {
                            Text(CalendarCopy.syncNow).foregroundStyle(Tokens.Text.tint.color)
                            Spacer()
                            Text(CalendarCopy.everyFifteen).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.secondary.color)
                        }
                    }
                    .accessibilityIdentifier("calendar.caldav.syncNow")
                } header: {
                    Text(CalendarCopy.afterConnecting)
                } footer: {
                    Text(CalendarCopy.syncedSettingFooter)
                }
            }
        }
        .tint(Tokens.Tint.base.color)
        .navigationTitle(CalendarCopy.caldavTitle)
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await store.sync() }
    }

    @ViewBuilder
    private func accountSection(_ account: CalendarStore.CaldavAccount) -> some View {
        let calendars = store.sources.filter { $0.provider == "caldav" && $0.kind == "calendar" && $0.accountId == account.accountId }
        Section {
            if !store.holdsCaldav(account.accountId) {
                Text(CalendarCopy.caldavSignInHere)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Task.dueToday.color)
            }
            ForEach(calendars, id: \.id) { source in
                Toggle(isOn: Binding(
                    get: { source.isSelected },
                    set: { on in Task { _ = await store.write { try $0.setSourceSelected(sourceId: source.id, selected: on) } } }
                )) {
                    HStack(spacing: Tokens.Space.medium) {
                        Circle().fill(source.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source.title)
                            Text(CalendarProviderStatus.text(source))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(source.syncStatus == "error" ? Tokens.Interaction.destructive.color : Tokens.Text.secondary.color)
                        }
                    }
                }
                .accessibilityIdentifier("calendar.caldav.calendar.\(source.title)")
            }
            Button(CalendarCopy.disconnect, role: .destructive) {
                Task { await store.disconnectCaldav(account.accountId) }
            }
            .accessibilityIdentifier("calendar.caldav.disconnect")
        } header: {
            Text("\(account.title) · \(URL(string: account.serverUrl)?.host() ?? account.serverUrl)")
        }
    }

    private func load() async {
        let core = store.core
        let values = await store.read {
            (try core.setting(path: "calendar.caldav.pushEventsToProvider"), try core.setting(path: "calendar.caldav.agentReadEventsConsent"))
        }
        push = values?.0 != "false"
        aiConsent = values?.1 == "true"
        outdated = await CalendarWriterCompat.outdatedDevices(account: account)
    }

    private func save(_ path: String, _ on: Bool) async {
        _ = await store.write { try $0.setSetting(path: path, valueJson: on ? "true" : "false") }
    }

    private func connect() async {
        connecting = true
        defer { connecting = false }
        error = await store.connectCaldav(server: serverAddress, username: username, password: password, preset: presetId)
        if error == nil { password = "" }
    }
}

/// Desktop `writer-compat.ts`: linked devices whose build predates write
/// routing (`CALENDAR_MULTI_WRITER_MIN_APP_VERSION`); phones and the web never
/// write to a calendar provider on their own, so only desktops count.
enum CalendarWriterCompat {
    static let minimumVersion = "2026.925.0"

    /// `isAppVersionBelow`: numeric major.minor.patch, JavaScript's
    /// `Number` per part (an empty part is 0), anything past the patch
    /// ignored, a part that is not a number reads as below.
    static func isBelow(_ version: String, _ minimum: String) -> Bool {
        let parse = { (value: String) -> [Double] in
            value.split(separator: ".", omittingEmptySubsequences: false).map { part in
                let text = part.trimmingCharacters(in: .whitespaces)
                return text.isEmpty ? 0 : Double(text) ?? .nan
            }
        }
        let a = parse(version), b = parse(minimum)
        let left = (0 ..< 3).map { $0 < a.count ? a[$0] : 0 }
        let right = (0 ..< 3).map { $0 < b.count ? b[$0] : 0 }
        guard left.allSatisfy(\.isFinite) else { return true }
        for index in 0 ..< 3 where left[index] != right[index] {
            return left[index] < right[index]
        }
        return false
    }

    @MainActor
    static func outdatedDevices(account: AccountModel?) async -> [String] {
        guard let account else { return [] }
        await account.loadDevices()
        return account.devices.filter { device in
            !device.isCurrent && !["ios", "android", "web"].contains(device.platform.lowercased())
                && device.appVersion.map { isBelow($0, minimumVersion) } ?? true
        }.map(\.name).reduce(into: [String]()) { names, name in
            if !names.contains(name) { names.append(name) }
        }
    }
}

extension CalendarCopy {
    static let caldavTitle = "CalDAV"
    static let caldavService = "Service"
    static let caldavServer = "Server"
    static let caldavHost = "Host"
    static let caldavUsername = "Username"
    static let caldavUsernamePlaceholder = "Email or user name"
    static let caldavPassword = "App password"
    static let caldavPasswordPlaceholder = "Required"
    static let caldavConnect = "Connect"
    static let afterConnecting = "After connecting"
    static let syncNow = "Sync now"
    static let everyFifteen = "every 15 min"
    static let disconnect = "Disconnect"
    static let caldavSignInHere = "Connected on another device. Connect here with its app password to sync on this iPhone."
    static let writerCompatTitle = "An older device may duplicate events"
    static let writerCompatAck = "I understand, connect anyway"
    static func writerCompatBody(_ devices: [String]) -> String {
        "\(devices.joined(separator: ", ")) runs an older memrynote. It can copy tasks and events from this calendar into Google as duplicates. Update it first, or continue."
    }

    static func caldavHelp(_ preset: String) -> String {
        let base = "Presets: iCloud, Fastmail, Nextcloud, Radicale/Baïkal, Zoho, Yahoo, mailbox.org, Posteo, Synology, Other (server address)."
        switch preset {
        case "icloud": return "iCloud needs an app-specific password from account.apple.com. " + base
        case "fastmail": return "Fastmail needs an app password (Settings › Privacy & Security › Integrations). " + base
        default: return "Use an app password when the service offers one. " + base
        }
    }

    /// `settings.json` `caldav.errors.*`.
    static func caldavError(_ code: String) -> String {
        switch code {
        case "invalid_url": "That server address isn't valid."
        case "unauthorized": "The username or app password was rejected."
        case "unreachable": "Couldn't reach the server. Check the address and your connection."
        case "not_caldav": "That server doesn't answer as a CalDAV calendar."
        case "no_calendars": "The account has no calendars with events."
        case "keychain": "Couldn't save the password on this iPhone."
        default: "Couldn't connect (\(code))."
        }
    }
}
