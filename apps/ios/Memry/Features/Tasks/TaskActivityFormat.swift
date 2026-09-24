import Foundation
import MemryCore

// TP043. How one activity entry reads, after desktop's `task-activity-row.tsx`
// (`fieldLabel`, `formatValue`, `descriptionSummary`, `actorLabel`,
// `formatRelativeTime`) and the day groups of `task-activity-sheet.tsx`.
//
// The core already resolved entity ids (project, status, parent, source note)
// to names; everything left here is a stored JSON scalar that needs a human
// form. Presentation only: nothing here decides what happened to the task.

/// One activity entry, as its row shows it.
struct TaskActivityLine: Equatable {
    /// The field's label, or the action's when no field changed.
    let label: String
    /// `from` value; `nil` when the entry carried none.
    let oldText: String?
    /// `to` value; `nil` when the entry carried none.
    let newText: String?
    /// Description rows: `+N chars`, `-N chars` or `reworded`, never the text.
    let summary: String?
    let isSuperseded: Bool
    /// "You", "Another device", or the superseded note.
    let actor: String
    let time: String

    /// The whole row as one sentence, for VoiceOver (the arrow is decorative).
    var accessibilityText: String {
        let what: String
        if let summary {
            what = "\(label): \(summary)"
        } else {
            what = [
                label,
                oldText.map(TasksCopy.Detail.activityFrom),
                newText.map(TasksCopy.Detail.activityTo)
            ].compactMap(\.self).joined(separator: " ")
        }
        return "\(what) · \(actor) · \(time)"
    }
}

/// A day of entries in the full sheet.
struct TaskActivityDay: Equatable {
    let label: String
    let entries: [ActivityItem]
}

enum TaskActivityFormat {
    private static let temporalFields: Set<String> = [
        "dueDate", "startDate", "completedAt", "archivedAt", "dueTime", "repeatFrom"
    ]

    static func line(_ entry: ActivityItem, now: Date) -> TaskActivityLine {
        let isSuperseded = entry.action == "superseded"
        let label = entry.field.map(TasksCopy.Detail.activityField) ?? TasksCopy.Detail.activityAction(entry.action)
        let time = relativeTime(entry.createdAtMs, now: now)
        let actor = isSuperseded
            ? TasksCopy.Detail.activitySupersededNote
            : (entry.isThisDevice ? TasksCopy.Detail.activityByYou : TasksCopy.Detail.activityBySync)
        if entry.field == "description" {
            return TaskActivityLine(
                label: label, oldText: nil, newText: nil, summary: descriptionSummary(entry.newValue),
                isSuperseded: isSuperseded, actor: actor, time: time
            )
        }
        return TaskActivityLine(
            label: label,
            oldText: entry.oldValue.map { value($0, field: entry.field) },
            newText: entry.newValue.map { value($0, field: entry.field) },
            summary: nil,
            isSuperseded: isSuperseded,
            actor: actor,
            time: time
        )
    }

    /// `formatValue`: a stored JSON value the way the properties show it.
    static func value(_ raw: String, field: String?) -> String {
        let decoded = decode(raw)
        switch decoded {
        case .none:
            return TasksCopy.Detail.activityEmptyValue
        case let .some(text as String):
            if text.isEmpty { return TasksCopy.Detail.activityEmptyValue }
            if let field, temporalFields.contains(field) { return temporal(text) }
            return text
        case let .some(number as NSNumber):
            if field == "priority", let priority = Int64(exactly: number), (0 ... 4).contains(priority) {
                return TasksCopy.priorityLabel(priority)
            }
            return number.stringValue
        case let .some(list as [Any]):
            let parts = list.map { "\($0)" }
            return parts.isEmpty ? TasksCopy.Detail.activityEmptyValue : parts.joined(separator: ", ")
        case .some:
            return TasksCopy.Detail.activityValueChanged
        }
    }

    /// `descriptionSummary`: `{ "delta": N }`, never the body.
    static func descriptionSummary(_ raw: String?) -> String {
        let delta = raw.flatMap { (decode($0) as? [String: Any])?["delta"] as? NSNumber }?.intValue ?? 0
        if delta > 0 { return TasksCopy.Detail.activityCharsAdded(delta) }
        if delta < 0 { return TasksCopy.Detail.activityCharsRemoved(delta) }
        return TasksCopy.Detail.activityCharsSame
    }

    /// `formatRelativeTime`: seconds, minutes, hours, then days.
    static func relativeTime(_ milliseconds: Int64?, now: Date) -> String {
        guard let milliseconds else { return "" }
        let then = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
        let seconds = Int((then.timeIntervalSince(now)).rounded())
        let magnitude = abs(seconds)
        var components = DateComponents()
        if magnitude < 60 {
            components.second = seconds
        } else if magnitude < 3600 {
            components.minute = Int((Double(seconds) / 60).rounded())
        } else if magnitude < 86400 {
            components.hour = Int((Double(seconds) / 3600).rounded())
        } else {
            components.day = Int((Double(seconds) / 86400).rounded())
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .named
        return formatter.localizedString(from: components)
    }

    /// The sheet's day groups, newest first as the core returned them.
    static func days(_ entries: [ActivityItem], now: Date) -> [TaskActivityDay] {
        let calendar = Calendar.current
        var days: [TaskActivityDay] = []
        var current: (label: String, entries: [ActivityItem])?
        for entry in entries {
            let label = dayLabel(entry.createdAtMs, now: now, calendar: calendar)
            if let open = current, open.label == label {
                current?.entries.append(entry)
            } else {
                if let open = current { days.append(TaskActivityDay(label: open.label, entries: open.entries)) }
                current = (label, [entry])
            }
        }
        if let open = current { days.append(TaskActivityDay(label: open.label, entries: open.entries)) }
        return days
    }

    private static func dayLabel(_ milliseconds: Int64?, now: Date, calendar: Calendar) -> String {
        guard let milliseconds else { return TasksCopy.Detail.activityUnknownDate }
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return TasksCopy.Detail.activityToday }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return TasksCopy.Detail.activityYesterday
        }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    private static func decode(_ raw: String) -> Any? {
        guard let data = raw.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else { return raw }
        return value is NSNull ? nil : value
    }

    /// ISO timestamps and bare dates both reach the feed.
    private static func temporal(_ text: String) -> String {
        if text.contains("T") {
            let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            let plain = Date.ISO8601FormatStyle()
            if let date = (try? iso.parse(text)) ?? (try? plain.parse(text)) {
                return date.formatted(.dateTime.month(.abbreviated).day().year().hour().minute())
            }
            return text
        }
        guard text.count >= 10, let date = TaskDates.date(text) else { return text }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
