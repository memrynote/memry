import MemryCore
import SwiftUI

// Spec 007 CL060 (artboard 27). Calendar settings: the accounts (Google,
// CalDAV, Subscribed, This iPhone) with their state on this device, the
// default calendar, week start, show notes, and the calendar-enabled date
// properties. Every setting but the device-local ones syncs both ways
// (goal D3a); device-local rows say so.

struct CalendarSettingsScreen: View {
    @Bindable var store: CalendarStore
    @Environment(TasksRouter.self) private var router
    @State private var weekStart = "monday"
    @State private var showNotes = false
    @State private var defaultTarget: String?
    @State private var dateProperties: [String] = []

    var body: some View {
        List {
            Section(CalendarCopy.accounts) {
                ForEach(CalendarProvider.all) { provider in
                    NavigationLink(value: CalendarRoute.provider(provider.id)) {
                        let line = status(provider)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.title)
                            Text(line.text)
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(line.color)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    .accessibilityIdentifier("calendar.settings.provider.\(provider.id)")
                }
            }
            Section {
                Picker(CalendarCopy.defaultCalendar, selection: $defaultTarget) {
                    Text(CalendarCopy.memryCalendarDefault).tag(String?.none)
                    ForEach(writable, id: \.id) { source in
                        Text("\(source.title) · \(CalendarProvider.named(source.provider).title)").tag(Optional(source.id))
                    }
                }
                .tint(Tokens.Text.secondary.color)
                .onChange(of: defaultTarget) { _, id in Task { await saveDefault(id) } }
                .accessibilityIdentifier("calendar.settings.default")
            } footer: {
                Text(CalendarCopy.defaultCalendarFooter)
            }
            Section {
                HStack {
                    Text(CalendarCopy.weekStartsOn)
                    Spacer()
                    Picker(CalendarCopy.weekStartsOn, selection: $weekStart) {
                        Text(CalendarCopy.sunday).tag("sunday")
                        Text(CalendarCopy.monday).tag("monday")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                }
                .onChange(of: weekStart) { _, value in Task { await save("calendar.weekStartDay", "\"\(value)\"") } }
                .accessibilityIdentifier("calendar.settings.weekStart")
                Toggle(CalendarCopy.showNotesOnCalendar, isOn: $showNotes)
                    .onChange(of: showNotes) { _, value in Task { await save("calendar.showNotesOnCalendar", value ? "true" : "false") } }
                    .accessibilityIdentifier("calendar.settings.showNotes")
            } footer: {
                Text(CalendarCopy.showNotesFooter)
            }
            Section {
                ForEach(datePropertyNames, id: \.self) { name in
                    Toggle(name, isOn: Binding(
                        get: { store.state.calendarProperties.contains(name) },
                        set: { on in
                            if on { store.state.calendarProperties.append(name) } else { store.state.calendarProperties.removeAll { $0 == name } }
                        }
                    ))
                }
            } header: {
                Text(CalendarCopy.dateProperties)
            } footer: {
                Text(CalendarCopy.datePropertiesFooter)
            }
        }
        .navigationTitle(CalendarCopy.calendarSettings)
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
    }

    private var writable: [CalendarSourceRecord] {
        store.sources.filter { $0.kind == "calendar" && ($0.provider == "google" || $0.provider == "caldav") && $0.isSelected }
    }

    private var datePropertyNames: [String] { dateProperties }

    /// Paper 27's status line: this device's connection state per service.
    private func status(_ provider: CalendarProvider) -> (text: String, color: Color) {
        let secondary = Tokens.Text.secondary.color
        let live = store.sources.filter { $0.provider == provider.id && $0.archivedAt == nil }
        switch provider.id {
        case "apple-eventkit":
            let kit = CalendarEventKitStore.shared
            return kit.access == .notDetermined ? (CalendarCopy.notAllowedYet, secondary) : (kit.statusText, secondary)
        case "ics":
            let links = live.filter { $0.kind == "calendar" }.count
            return (links == 0 ? CalendarCopy.subscribedHint : CalendarCopy.linksReadOnly(links), secondary)
        default:
            let accounts = live.filter { $0.kind == "account" }
            guard !accounts.isEmpty else {
                return (provider.id == "caldav" ? CalendarCopy.caldavHint : CalendarCopy.notConnected, secondary)
            }
            // Credentials stay on each device: a row another device connected
            // reads as not signed in here.
            let held = accounts.filter { account in
                guard let id = account.accountId else { return false }
                return provider.id == "caldav" ? store.holdsCaldav(id) : store.holdsGoogle(id)
            }
            guard !held.isEmpty else { return (CalendarCopy.signInHere, Tokens.Calendar.amber.meta.color) }
            return (CalendarCopy.connectedAccounts(held.count), Tokens.Calendar.green.meta.color)
        }
    }

    private func load() async {
        let core = store.core
        let values = await store.read {
            (
                try core.setting(path: "calendar.weekStartDay"),
                try core.setting(path: "calendar.showNotesOnCalendar"),
                try core.setting(path: "calendar.defaultWriteTarget"),
                try core.setting(path: "calendar.google.defaultTargetCalendarId")
            )
        }
        weekStart = values?.0 == "\"sunday\"" ? "sunday" : "monday"
        showNotes = values?.1 == "true"
        defaultTarget = CalendarDefaultTarget.sourceId(target: values?.2, google: values?.3, sources: store.sources)
        dateProperties = await store.datePropertyNames()
    }

    /// Week start and show notes change what the grid asks for: re-read the
    /// settings the store caches, then its windows.
    private func save(_ path: String, _ json: String) async {
        await store.write { try $0.setSetting(path: path, valueJson: json) }
        await store.refreshSources()
        await store.refreshAllWindows()
    }

    /// One provider holds the default (`write-routing.ts`): a Google calendar
    /// is written to Google's own key too, as desktop's picker does.
    private func saveDefault(_ sourceId: String?) async {
        let source = store.sources.first { $0.id == sourceId }
        let target = source.map { "{\"provider\":\"\($0.provider)\",\"remoteCalendarId\":\(CalendarDefaultTarget.json($0.remoteId))}" } ?? "null"
        await save("calendar.defaultWriteTarget", target)
        if source?.provider == "google" || source == nil {
            await save("calendar.google.defaultTargetCalendarId", source.map { CalendarDefaultTarget.json($0.remoteId) } ?? "null")
        }
    }
}

enum CalendarDefaultTarget {
    static func json(_ text: String) -> String {
        (try? String(data: JSONEncoder().encode(text), encoding: .utf8)) ?? "\"\""
    }

    /// `readDefaultWriteTarget`: the cross-provider target, else Google's.
    static func sourceId(target: String?, google: String?, sources: [CalendarSourceRecord]) -> String? {
        if let target, let data = target.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
           let remote = object["remoteCalendarId"] {
            return sources.first { $0.remoteId == remote && $0.provider == object["provider"] }?.id
        }
        if let google, let data = google.data(using: .utf8), let remote = try? JSONDecoder().decode(String.self, from: data) {
            return sources.first { $0.remoteId == remote && $0.provider == "google" }?.id
        }
        return nil
    }
}

/// The four providers of artboard 27.
struct CalendarProvider: Identifiable, Equatable {
    let id: String
    let title: String
    let symbol: String

    static let all = [
        CalendarProvider(id: "google", title: "Google Calendar", symbol: "g.circle"),
        CalendarProvider(id: "caldav", title: "CalDAV", symbol: "server.rack"),
        CalendarProvider(id: "ics", title: "Subscribed calendars", symbol: "link"),
        CalendarProvider(id: "apple-eventkit", title: "This iPhone", symbol: "iphone")
    ]

    static func named(_ id: String) -> CalendarProvider {
        all.first { $0.id == id } ?? CalendarProvider(id: id, title: id, symbol: "calendar")
    }
}

extension CalendarStore {
    /// The vault's date property definitions (the calendar-enabled set is
    /// chosen among them).
    func datePropertyNames() async -> [String] {
        guard let core = tasks?.core else { return state.calendarProperties }
        let definitions = await read { try core.propertyDefinitions() } ?? []
        let names = definitions.filter { $0.typeName == "date" }.map(\.name)
        return Array(Set(names + state.calendarProperties)).sorted()
    }
}

extension CalendarCopy {
    static let accounts = "Accounts"
    static let defaultCalendar = "Default calendar"
    static let defaultCalendarFooter = "Where new events, tasks, reminders and snoozes go when you don't pick a calendar. One service holds the default."
    static let weekStartsOn = "Week starts on"
    static let sunday = "Sunday"
    static let monday = "Monday"
    static let showNotesOnCalendar = "Show notes on calendar"
    static let showNotesFooter = "Shows every note as an all-day item on the day it was created."
    static let dateProperties = "Date properties on this iPhone"
    static let datePropertiesFooter = "Notes with these date properties appear on that day. This choice stays on this iPhone, as on your computer."
    static let notConnected = "Not connected"
    static let notAllowedYet = "Not allowed yet"
    static let signInHere = "Connected on another device · sign in here"
    static let caldavHint = "Fastmail · iCloud, Nextcloud and more"
    static let subscribedHint = "Add a webcal or .ics link"
    static func linksReadOnly(_ count: Int) -> String { count == 1 ? "1 link · read-only" : "\(count) links · read-only" }
    static func connectedAccounts(_ count: Int) -> String { count == 1 ? "Connected · 1 account" : "Connected · \(count) accounts" }
}
