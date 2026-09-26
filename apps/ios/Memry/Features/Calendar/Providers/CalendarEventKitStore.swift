import EventKit
import Foundation
import MemryCore
import Observation

// Spec 007 CL064 (goal D4, artboard 31). This iPhone: EventKit read on the
// device only, read-only, never synced — desktop's device-local
// `apple-eventkit` provider. Enablement and the per-calendar switches are
// device-local (UserDefaults); the duplicate guard starts a calendar off when
// the same calendar is already connected through Google or CalDAV.

@MainActor
@Observable
final class CalendarEventKitStore {
    static let shared = CalendarEventKitStore()

    enum Access: Equatable { case notDetermined, denied, restricted, writeOnly, allowed }

    struct LocalCalendar: Identifiable, Equatable {
        let id: String
        let title: String
        let colorHex: String?
        let source: String
        var isOn: Bool
        let isDuplicate: Bool
    }

    private(set) var access: Access = .notDetermined
    private(set) var calendars: [LocalCalendar] = []
    private(set) var events: [String: CalendarExternalEventRecord] = [:]
    private let store = EKEventStore()
    private let defaults: UserDefaults
    private static let enabledKey = "calendar.eventkit.enabled"
    private static let calendarsKey = "calendar.eventkit.calendars"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        isEnabled = defaults.bool(forKey: Self.enabledKey)
        refreshAccess()
    }

    /// Stored so views observe it; the defaults key keeps it across launches.
    var isEnabled: Bool {
        didSet { defaults.set(isEnabled, forKey: Self.enabledKey) }
    }

    var statusText: String {
        switch access {
        case .allowed: isEnabled ? CalendarCopy.eventKitOn : CalendarCopy.eventKitOff
        case .denied, .restricted: CalendarCopy.eventKitDenied
        case .writeOnly: CalendarCopy.eventKitWriteOnly
        case .notDetermined: CalendarCopy.eventKitOff
        }
    }

    func refreshAccess() {
        let before = access
        defer {
            // A store made before access was granted reads nothing until reset.
            if access == .allowed, before != .allowed { store.reset() }
        }
        access = switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: .allowed
        case .writeOnly: .writeOnly
        case .denied: .denied
        case .restricted: .restricted
        default: .notDetermined
        }
    }

    /// `requestFullAccessToEvents` (artboard 31 state A → B or C).
    func requestAccess() async {
        _ = try? await store.requestFullAccessToEvents()
        refreshAccess()
        if access == .allowed { isEnabled = true }
    }

    /// Reloads this iPhone's calendars, marking duplicates of calendars already
    /// connected through a synced provider (they start off).
    func reloadCalendars(synced: [CalendarSourceRecord]) {
        guard access == .allowed else { calendars = []; return }
        let saved = defaults.dictionary(forKey: Self.calendarsKey) as? [String: Bool] ?? [:]
        let syncedTitles = Set(synced.filter { $0.provider == "google" || $0.provider == "caldav" }.map { $0.title.lowercased() })
        calendars = store.calendars(for: .event).map { calendar in
            let duplicate = syncedTitles.contains(calendar.title.lowercased())
            return LocalCalendar(
                id: calendar.calendarIdentifier,
                title: calendar.title,
                colorHex: calendar.cgColor.flatMap(Self.hex),
                source: calendar.source.title,
                isOn: saved[calendar.calendarIdentifier] ?? !duplicate,
                isDuplicate: duplicate
            )
        }
    }

    func set(_ id: String, on: Bool) {
        var saved = defaults.dictionary(forKey: Self.calendarsKey) as? [String: Bool] ?? [:]
        saved[id] = on
        defaults.set(saved, forKey: Self.calendarsKey)
        if let index = calendars.firstIndex(where: { $0.id == id }) { calendars[index].isOn = on }
    }

    /// The window's events from the enabled calendars, as projection items.
    func items(from: Date, to: Date, zone: String) -> [CalendarItem] {
        guard access == .allowed, isEnabled else { return [] }
        let enabled = store.calendars(for: .event).filter { calendar in
            calendars.first { $0.id == calendar.calendarIdentifier }?.isOn ?? true
        }
        guard !enabled.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: enabled)
        return store.events(matching: predicate).map { event in
            let id = "eventkit:\(event.calendarItemIdentifier):\(Int(event.startDate.timeIntervalSince1970))"
            events[id] = record(event, id: id)
            let color = event.calendar.cgColor.flatMap(Self.hex)
            return CalendarItem(
                projectionId: "external_event:\(id)",
                sourceType: "external_event",
                sourceId: id,
                title: event.title ?? "",
                descriptionPreview: event.notes.map { String($0.prefix(280)) },
                startAt: CalendarDates.iso(event.startDate),
                endAt: CalendarDates.iso(event.endDate),
                isAllDay: event.isAllDay,
                timezone: event.timeZone?.identifier ?? zone,
                visualType: "external_event",
                editability: CalendarEditability(canMove: false, canResize: false, canEditText: false, canDelete: false),
                source: CalendarItemSource(
                    provider: "apple-eventkit", calendarSourceId: "eventkit:\(event.calendar.calendarIdentifier)",
                    title: event.calendar.title, color: color, kind: "calendar", isMemryManaged: false
                ),
                binding: nil, snoozeOffsetMinutes: nil, color: nil, displayColor: color,
                noteId: nil, anchorId: nil, isTriggered: nil
            )
        }
    }

    func record(_ id: String) -> CalendarExternalEventRecord? { events[id] }

    private func record(_ event: EKEvent, id: String) -> CalendarExternalEventRecord {
        CalendarExternalEventRecord(
            id: id, title: event.title ?? "", description: event.notes, location: event.location,
            startAt: CalendarDates.iso(event.startDate), endAt: CalendarDates.iso(event.endDate),
            timezone: event.timeZone?.identifier, isAllDay: event.isAllDay, status: "confirmed",
            recurrenceRuleJson: event.recurrenceRules?.first.map { "{\"rrule\":[\"RRULE:\($0.description.components(separatedBy: "RRULE ").last ?? "")\"]}" },
            attendeesJson: nil,
            remindersJson: event.alarms.map { alarms in
                let minutes = alarms.map { Int(-$0.relativeOffset / 60) }
                return "{\"useDefault\":false,\"overrides\":[\(minutes.map { "{\"minutes\":\($0)}" }.joined(separator: ","))]}"
            },
            conferenceDataJson: event.url.map { "{\"entryPoints\":[{\"entryPointType\":\"video\",\"uri\":\"\($0.absoluteString)\"}]}" },
            sourceId: nil, sourceProvider: "apple-eventkit", sourceTitle: event.calendar.title,
            sourceColor: event.calendar.cgColor.flatMap(Self.hex), accountTitle: event.calendar.source.title,
            isPromotable: false
        )
    }

    private static func hex(_ color: CGColor) -> String? {
        guard let rgb = color.converted(to: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(), intent: .defaultIntent, options: nil),
              let parts = rgb.components, parts.count >= 3 else { return nil }
        return String(format: "#%02x%02x%02x", Int(parts[0] * 255), Int(parts[1] * 255), Int(parts[2] * 255))
    }
}

extension CalendarCopy {
    static let eventKitOn = "On"
    static let eventKitOff = "Off"
    static let eventKitDenied = "No access"
    static let eventKitWriteOnly = "Add-only access"
}
