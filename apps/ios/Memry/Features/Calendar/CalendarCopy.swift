import Foundation

// Spec 007: every string the calendar shows, in desktop's wording
// (`packages/i18n/src/locales/en/calendar.json`, the `calendar` block of
// `settings.json`). Literals, as the Tasks and Inbox copy are (spec-defect 98).

enum CalendarCopy {
    static let title = "Calendar"
    static let yearHint = "tap a day to peek, a month to open"

    // MARK: Views (`view.*`)

    static func view(_ mode: CalendarViewMode) -> String {
        switch mode {
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        case .year: "Year"
        case .timeline: "Timeline"
        }
    }

    static let today = "Today"
    static let goToDate = "Go to date…"
    static let calendarSettings = "Calendar settings"
    static let titleMenuHint = "Switch the view or jump to a date"
    static let previousPeriod = "Previous period"
    static let nextPeriod = "Next period"
    static let createEvent = "Create event"
    static let createEventHint = "Adds an event on the day in view"

    // MARK: Search and filter

    static let searchOpen = "Search calendar"
    static let searchPlaceholder = "Search events, tasks, reminders…"
    static let clearSearch = "Clear search"
    static let searchHint = "Tap a result to jump to its day and open it."
    static let noResults = "No matches"
    static let thisWeek = "This week"
    static let later = "Later"
    static let earlier = "Earlier"
    static let filterCalendars = "Calendars"
    static let filterScope = "Filters apply on this iPhone only"
    static let filterButton = "Filter calendars"
    static let sources = "Sources"
    static let memryItems = "memrynote items"
    static let importedCalendars = "Imported calendars"
    static let eventTypes = "Event types"
    static let googleCalendars = "Google calendars"
    static let refreshCalendars = "Refresh Google calendars"
    static let notSyncing = "Not syncing · tick to turn on"
    static let enableSourceFailed = "Could not turn that calendar on."
    static let manageAccounts = "Manage accounts"
    static let noImportedCalendars = "No imported calendars yet."

    static func providerCalendars(_ provider: String) -> String {
        switch provider {
        case "google": googleCalendars
        case "ics": "Subscribed calendars"
        case "caldav": "CalDAV calendars"
        case "apple-eventkit": "This iPhone"
        default: "Other calendars"
        }
    }

    // MARK: Visual types (`visual-type.*`)

    static func visualType(_ type: String) -> String {
        switch type {
        case "external_event": "Imported event"
        case "note": "Note"
        case "note_date": "Date reminder"
        case "task": "Task"
        case "reminder": "Reminder"
        case "snooze": "Snooze"
        default: "Event"
        }
    }

    // MARK: Time

    static let allDay = "All day"
    static let allDayLower = "all-day"
    static let noon = "Noon"
    static let noEvents = "No events"
    static let loading = "Loading calendar…"
    static let newEvent = "New Event"

    static func moreEvents(_ count: Int) -> String {
        count == 1 ? "1 more event" : "\(count) more events"
    }

    /// `chip.duration-*`.
    static func duration(minutes: Int) -> String {
        let hours = minutes / 60, rest = minutes % 60
        if hours == 0 { return "\(rest)m" }
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }

    static func dayOf(_ day: Int, _ total: Int) -> String { "Day \(day) of \(total)" }

    // MARK: Chips

    static func completeTask(_ title: String) -> String { "Complete \(title)" }
    static let taskCompleted = "Task completed"
    static let couldNotComplete = "Could not complete task"
    static let undo = "Undo"
    static let undoHint = "Reverts the last change"
    static let moveEarlier = "Move 15 minutes earlier"
    static let moveLater = "Move 15 minutes later"
    static let open = "Open"
    static let delete = "Delete event"
    static let addToProject = "Add to project"
    static func newEventAt(_ time: String) -> String { "New event at \(time)" }
    /// Paper 16: "Moved to 12:00".
    static func movedTo(_ time: String) -> String { "Moved to \(time)" }
    static func resizedTo(_ start: String, _ end: String) -> String { "Now \(start) – \(end)" }
    static let taskRescheduled = "Task rescheduled"
    static let moveEvent = "Move event"
    static let rescheduleTask = "Reschedule task"

    // MARK: Errors (`phaseI.errors.*`)

    static let couldNotSave = "Could not save event. Try again."
    static let couldNotCreate = "Could not create event. Try again."
    static let couldNotEdit = "Could not edit this event. Try again."
    static let couldNotDelete = "Failed to delete event"
    static let projectUpdateFailed = "Could not update the event's project"
}
