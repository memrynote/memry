import MemryCore
import SwiftUI

// Spec 007 CL042/CL051. The read-only event metadata desktop shows
// (`calendar-event-metadata.tsx`, `calendar-subscribed-event-popover.tsx`):
// attendees with responses, reminders, visibility, the conference link and
// phone PIN, and `describeRecurrence`.

enum CalendarEventMetadata {
    struct Attendee: Identifiable, Equatable {
        var id: String { email ?? name ?? UUID().uuidString }
        let name: String?
        let email: String?
        let response: String?
        let isOrganizer: Bool
        let isOptional: Bool
    }

    private static func object(_ json: String?) -> Any? {
        guard let data = json?.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    static func attendees(_ json: String?) -> [Attendee] {
        (object(json) as? [[String: Any]] ?? []).map { raw in
            Attendee(
                name: raw["displayName"] as? String ?? raw["name"] as? String,
                email: raw["email"] as? String,
                response: raw["responseStatus"] as? String,
                isOrganizer: raw["organizer"] as? Bool ?? false,
                isOptional: raw["optional"] as? Bool ?? false
            )
        }
    }

    /// `{ useDefault, overrides: [{ method, minutes }] }`.
    static func reminders(_ json: String?) -> (useDefault: Bool, minutes: [Int])? {
        guard let raw = object(json) as? [String: Any] else { return nil }
        let overrides = (raw["overrides"] as? [[String: Any]] ?? []).compactMap { ($0["minutes"] as? NSNumber)?.intValue }
        return (raw["useDefault"] as? Bool ?? false, overrides)
    }

    /// The first video entry point (Google `conferenceData.entryPoints`).
    static func joinURL(_ json: String?) -> URL? {
        let points = (object(json) as? [String: Any])?["entryPoints"] as? [[String: Any]] ?? []
        let video = points.first { ($0["entryPointType"] as? String ?? "video") == "video" } ?? points.first
        return (video?["uri"] as? String).flatMap(URL.init(string:))
    }

    /// "Google Meet", "Zoom": `conferenceSolution.name`.
    static func conferenceName(_ json: String?) -> String? {
        ((object(json) as? [String: Any])?["conferenceSolution"] as? [String: Any])?["name"] as? String
    }

    /// A phone entry point and its PIN, when the call has one.
    static func phone(_ json: String?) -> (uri: URL, label: String, pin: String?)? {
        let points = (object(json) as? [String: Any])?["entryPoints"] as? [[String: Any]] ?? []
        guard let entry = points.first(where: { $0["entryPointType"] as? String == "phone" }),
              let uri = (entry["uri"] as? String).flatMap(URL.init(string:)) else { return nil }
        return (uri, entry["label"] as? String ?? uri.absoluteString, entry["pin"] as? String)
    }

    /// `describeRecurrence` over the stored rule (`{ rrule: ["RRULE:…"] }` or
    /// `{ freq, interval, byDay }`).
    static func recurrence(_ json: String?) -> String? {
        guard let raw = object(json) as? [String: Any] else { return nil }
        var parts: [String: String] = [:]
        if let rules = raw["rrule"] as? [String] ?? raw["recurrence"] as? [String],
           let line = rules.first(where: { $0.uppercased().hasPrefix("RRULE:") }) ?? rules.first {
            for pair in line.replacingOccurrences(of: "RRULE:", with: "").split(separator: ";") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 { parts[String(kv[0]).uppercased()] = String(kv[1]) }
            }
        } else {
            for (key, value) in raw { parts[key.uppercased()] = "\(value)" }
        }
        let count = Int(parts["INTERVAL"] ?? "1") ?? 1
        switch (parts["FREQ"] ?? "").uppercased() {
        case "DAILY": return count == 1 ? "Repeats every day" : "Repeats every \(count) days"
        case "WEEKLY":
            let base = count == 1 ? "Repeats every week" : "Repeats every \(count) weeks"
            guard let days = parts["BYDAY"], !days.isEmpty else { return base }
            return "\(base) on \(weekdayNames(days))"
        case "MONTHLY": return count == 1 ? "Repeats every month" : "Repeats every \(count) months"
        case "YEARLY": return count == 1 ? "Repeats every year" : "Repeats every \(count) years"
        default: return "Repeats"
        }
    }

    private static func weekdayNames(_ byDay: String) -> String {
        let order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
        let symbols = Calendar.current.shortWeekdaySymbols
        return byDay.split(separator: ",").compactMap { code in
            order.firstIndex(of: String(code.suffix(2))).map { symbols[$0] }
        }.joined(separator: ", ")
    }
}

/// Attendees (six, then Show more), reminders, visibility, description.
struct CalendarEventMetadataSections: View {
    let attendeesJson: String?
    let remindersJson: String?
    let visibility: String?
    let description: String?
    @State private var showAll = false

    var body: some View {
        let attendees = CalendarEventMetadata.attendees(attendeesJson)
        if !attendees.isEmpty {
            Section("\(CalendarCopy.attendees) (\(attendees.count))") {
                ForEach(showAll ? attendees : Array(attendees.prefix(6))) { attendee in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(attendee.name ?? attendee.email ?? "")
                            if attendee.isOrganizer {
                                Text(CalendarCopy.organizer).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
                            }
                        }
                        Spacer()
                        Text(CalendarCopy.response(attendee.response ?? ""))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                }
                if attendees.count > 6 {
                    Button(showAll ? CalendarCopy.showLess : CalendarCopy.showMore) { showAll.toggle() }
                }
            }
        }
        if let reminders = CalendarEventMetadata.reminders(remindersJson) {
            Section(CalendarCopy.reminders) {
                if reminders.useDefault { Text(CalendarCopy.defaultReminders) }
                ForEach(reminders.minutes, id: \.self) { Text(CalendarCopy.alert(minutes: $0)) }
            }
        }
        if let visibility, visibility != "default" {
            Section { LabeledContent(CalendarCopy.visibility, value: CalendarCopy.visibilityValue(visibility)) }
        }
        if let description, !description.isEmpty {
            Section(CalendarCopy.notes) {
                Text(LocalizedStringKey(description))
                    .textSelection(.enabled)
                    .tint(Tokens.Text.tint.color)
            }
        }
    }
}

/// Artboard 19: subscribed, read-only CalDAV and This iPhone events.
struct CalendarReadOnlySheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @State private var record: CalendarExternalEventRecord?
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    CalendarSheetHeader(item: item, kind: kind, badge: CalendarCopy.readOnly)
                }
                .listRowBackground(Color.clear)
                if failed {
                    Text(CalendarCopy.detailsFailed)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                if let record {
                    if let text = CalendarEventMetadata.recurrence(record.recurrenceRuleJson) {
                        Label(text, systemImage: "repeat")
                    }
                    if let join = CalendarEventMetadata.joinURL(record.conferenceDataJson) {
                        Button { openURL(join) } label: { Label(CalendarCopy.joinMeeting, systemImage: "video") }
                    }
                    if let phone = CalendarEventMetadata.phone(record.conferenceDataJson) {
                        Button { openURL(phone.uri) } label: {
                            Label(phone.pin.map { "\(phone.label) · PIN \($0)" } ?? phone.label, systemImage: "phone")
                        }
                    }
                    if let location = record.location, !location.isEmpty {
                        Label(location, systemImage: "mappin.and.ellipse")
                    }
                    CalendarEventMetadataSections(
                        attendeesJson: record.attendeesJson, remindersJson: record.remindersJson,
                        visibility: nil, description: record.description
                    )
                    Section {
                        Text(CalendarCopy.changeItIn(record.sourceTitle ?? item.source.title))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CalendarCloseButton { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            let core = store.core
            let id = item.sourceId
            if let local = CalendarEventKitStore.shared.record(id) {
                record = local
            } else {
                record = await store.read { try core.externalEvent(id: id) } ?? nil
            }
            failed = record == nil
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.readonly")
    }

    private var kind: String {
        switch item.source.provider {
        case "apple-eventkit": CalendarCopy.thisIPhone
        case "ics": CalendarCopy.subscribedKind
        default: CalendarCopy.visualType(item.visualType)
        }
    }
}
