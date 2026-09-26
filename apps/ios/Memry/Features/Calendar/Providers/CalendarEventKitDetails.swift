import EventKit
import Foundation

// Spec 007 CL051/CL064. EventKit's event details in the shapes the mirror
// stores for Google (desktop `eventkit-details.ts`), so the read-only sheet
// shows attendees, alerts, the repeat rule and a Join button the same way.

enum CalendarEventKitDetails {
    private static func json(_ value: Any?) -> String? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private static func email(_ participant: EKParticipant) -> String? {
        let url = participant.url.absoluteString
        guard url.lowercased().hasPrefix("mailto:") else { return nil }
        let address = String(url.dropFirst("mailto:".count))
        return address.isEmpty ? nil : address
    }

    private static func response(_ status: EKParticipantStatus) -> String {
        switch status {
        case .accepted: "accepted"
        case .declined: "declined"
        case .tentative: "tentative"
        default: "needsAction"
        }
    }

    private static func same(_ left: EKParticipant, _ right: EKParticipant) -> Bool {
        if let a = email(left), let b = email(right) { return a.lowercased() == b.lowercased() }
        return email(left) == nil && email(right) == nil && left.name == right.name
    }

    private static func attendee(_ participant: EKParticipant, organizer: Bool) -> [String: Any] {
        var row: [String: Any] = [
            "email": email(participant) ?? "",
            "responseStatus": response(participant.participantStatus),
            "optional": participant.participantRole == .optional,
            "organizer": organizer,
            "self": participant.isCurrentUser
        ]
        if let name = participant.name { row["displayName"] = name }
        return row
    }

    /// `eventKitAttendees`: the organizer first; nil when EventKit lists nobody.
    static func attendees(_ event: EKEvent) -> String? {
        let listed = (event.attendees ?? []).filter { email($0) != nil || $0.name != nil }
        let organizer = event.organizer
        let isOrganizer = { (participant: EKParticipant) -> Bool in
            participant.participantRole == .chair || organizer.map { same(participant, $0) } == true
        }
        var rows = listed.map { attendee($0, organizer: isOrganizer($0)) }
        // A meeting's organizer is not always in its attendee list.
        if let organizer, !listed.contains(where: { same($0, organizer) }), !rows.isEmpty,
           email(organizer) != nil || organizer.name != nil {
            rows.insert(attendee(organizer, organizer: true), at: 0)
        }
        let sorted = rows.enumerated().sorted { lhs, rhs in
            let (a, b) = (lhs.element["organizer"] as? Bool == true, rhs.element["organizer"] as? Bool == true)
            return a != b ? a : lhs.offset < rhs.offset
        }.map(\.element)
        return sorted.isEmpty ? nil : json(sorted)
    }

    /// `eventKitReminders`: alerts before the start, soonest last.
    static func reminders(_ event: EKEvent) -> String? {
        let minutes = Set((event.alarms ?? []).compactMap { alarm -> Int? in
            guard alarm.absoluteDate == nil else { return nil }
            let value = Int((-alarm.relativeOffset / 60).rounded())
            return value >= 0 ? value : nil
        }).sorted(by: >)
        guard !minutes.isEmpty else { return nil }
        return json(["useDefault": false, "overrides": minutes.map { ["method": "popup", "minutes": $0] }])
    }

    /// `eventKitRecurrence`: `{ rrule: "FREQ=…" }`.
    static func recurrence(_ event: EKEvent) -> String? {
        guard let rule = event.recurrenceRules?.first else { return nil }
        let text = rule.description
        guard let range = text.range(of: "RRULE ") else { return nil }
        return json(["rrule": String(text[range.upperBound...]).trimmingCharacters(in: .whitespaces)])
    }

    private static let services: [(name: String, key: String, pattern: String)] = [
        ("Google Meet", "hangoutsMeet", #"https://meet\.google\.com/[a-z0-9-]+(?:\?[^\s<>"')\]]*)?"#),
        ("Zoom", "zoom", #"https://(?:[\w-]+\.)?zoom\.us/(?:j|my|w)/[^\s<>"')\]]+"#),
        ("Microsoft Teams", "teams", #"https://teams\.microsoft\.com/l/meetup-join/[^\s<>"')\]]+"#),
        ("Webex", "webex", #"https://[\w-]+\.webex\.com/[^\s<>"')\]]+"#)
    ]

    private static func first(_ pattern: String, in text: String) -> String? {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]).map { String(text[$0]) }
    }

    /// `eventKitConference`: a Meet, Zoom, Teams or Webex link in the URL,
    /// location or notes (EventKit has no conference field), with a `tel:`
    /// line from the notes.
    static func conference(_ event: EKEvent) -> String? {
        let haystacks = [event.url?.absoluteString, event.location, event.notes].compactMap { $0 }.filter { !$0.isEmpty }
        for service in services {
            for text in haystacks {
                guard let link = first(service.pattern, in: text) else { continue }
                var points: [[String: Any]] = [
                    ["entryPointType": "video", "uri": link, "label": link.replacingOccurrences(of: "https://", with: "")]
                ]
                if let phone = event.notes.flatMap({ first(#"tel:\+?[0-9][0-9;,#*+-]*"#, in: $0) }) {
                    points.append(["entryPointType": "phone", "uri": phone])
                }
                return json(["conferenceSolution": ["key": ["type": service.key], "name": service.name], "entryPoints": points])
            }
        }
        return nil
    }
}
