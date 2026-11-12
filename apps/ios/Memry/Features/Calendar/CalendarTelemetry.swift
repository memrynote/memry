import MemryCore

// Desktop parity for calendar events (`ipc/calendar-handlers.ts`,
// `ipc/calendar-telemetry.ts`, `calendar/promote-external-event.ts`,
// `calendar/google/google-provider.ts`). Each is sent after the core write
// returned.

enum CalendarTelemetry {
    static func eventCreated() {
        Telemetry.shared.track(.calendarEventCreated, surface: .calendar, action: "created", source: "calendar_page", result: .success)
    }

    /// `itemCount` is the number of fields the edit sets, as desktop counts
    /// its `changedFields` (the target calendar excluded).
    static func eventUpdated(_ changes: CalendarEventChanges) {
        let set = [
            changes.title != nil, changes.description != .keep, changes.location != .keep,
            changes.startAt != nil, changes.endAt != .keep, changes.timezone != nil,
            changes.isAllDay != nil, changes.color != .keep
        ].filter { $0 }.count
        Telemetry.shared.track(
            .calendarEventUpdated, surface: .calendar, action: "updated", result: .success,
            metrics: TelemetryMetrics(itemCount: Double(set))
        )
    }

    static func eventDeleted() {
        Telemetry.shared.track(.calendarEventDeleted, surface: .calendar, action: "deleted", source: "calendar_page", result: .success)
    }

    static func eventPromoted(provider: String?) {
        let source: StaticString? = switch provider ?? "google" {
        case "google": "google_promote"
        case "caldav": "caldav_promote"
        default: nil
        }
        Telemetry.shared.track(.calendarEventCreated, surface: .calendar, action: "promoted", source: source, result: .success)
    }

    static func googleConnected() {
        Telemetry.shared.track(.calendarGoogleConnected, surface: .calendar, action: "connected", source: "google", result: .success)
    }

    static func googleDisconnected() {
        Telemetry.shared.track(
            .calendarGoogleDisconnected, surface: .calendar, action: "disconnected", source: "google", result: .success,
            metrics: TelemetryMetrics(itemCount: 1)
        )
    }
}
