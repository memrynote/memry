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
                        HStack {
                            Label(provider.title, systemImage: provider.symbol)
                            Spacer()
                            Text(status(provider))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
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
                .onChange(of: defaultTarget) { _, id in Task { await saveDefault(id) } }
                .accessibilityIdentifier("calendar.settings.default")
            } footer: {
                Text(CalendarCopy.defaultCalendarFooter)
            }
            Section {
                Picker(CalendarCopy.weekStartsOn, selection: $weekStart) {
                    Text(CalendarCopy.sunday).tag("sunday")
                    Text(CalendarCopy.monday).tag("monday")
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
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var writable: [CalendarSourceRecord] {
        store.sources.filter { $0.kind == "calendar" && ($0.provider == "google" || $0.provider == "caldav") && $0.isSelected }
    }

    private var datePropertyNames: [String] { dateProperties }

    private func status(_ provider: CalendarProvider) -> String {
        let sources = store.sources.filter { $0.provider == provider.id }
        if provider.id == "apple-eventkit" { return CalendarEventKitStore.shared.statusText }
        guard !sources.isEmpty else { return CalendarCopy.notConnected }
        let calendars = sources.filter { $0.kind == "calendar" && $0.isSelected }.count
        return CalendarCopy.calendarsCount(calendars)
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

    private func save(_ path: String, _ json: String) async {
        await store.write { try $0.setSetting(path: path, valueJson: json) }
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
    static let defaultCalendarFooter = "New events, and tasks and reminders you schedule, go here unless you pick another calendar."
    static let weekStartsOn = "Week starts on"
    static let sunday = "Sunday"
    static let monday = "Monday"
    static let showNotesOnCalendar = "Show notes on calendar"
    static let showNotesFooter = "Every note appears as an all-day item on the day it was created. Syncs with your other devices."
    static let dateProperties = "Date properties on this iPhone"
    static let datePropertiesFooter = "Notes with these date properties appear on that day. This choice stays on this iPhone, as on your computer."
    static let notConnected = "Not connected"
    static func calendarsCount(_ count: Int) -> String { count == 1 ? "1 calendar" : "\(count) calendars" }
}
