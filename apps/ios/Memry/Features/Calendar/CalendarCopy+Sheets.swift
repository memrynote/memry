import Foundation
import MemryCore

// Spec 007: copy for sheets, the timeline and alerts (`calendar.json`
// `delete-dialog`, `timeline`, `promote-dialog`, `task-popover`,
// `notePopover`, `phaseI.inboxSnoozePopover`, `subscribedEvent`, `metadata`).

extension CalendarCopy {
    static let cancel = "Cancel"
    static let close = "Close"
    static let save = "Save"
    static let clear = "Clear"
    static let done = "Done"
    static let more = "More…"

    // MARK: Delete (22)

    static let deleteTitle = "Delete event?"
    static let deleteConfirm = "Delete"

    static func deleteMessage(_ item: CalendarItem) -> String {
        item.binding?.provider == "google"
            ? "\"\(item.title)\" will be removed from memrynote and Google Calendar. This action cannot be undone."
            : "\"\(item.title)\" will be permanently deleted. This action cannot be undone."
    }

    // MARK: Promote (18)

    static let promoteTitle = "Edit this event in memrynote?"
    static let promoteBody = "Editing this event will create a linked copy in memrynote so changes sync both ways. Continue?"
    static let promoteDontAsk = "Don't ask again"
    static let promoteConfirm = "Edit in memrynote"
    static let promoteAgentNotice = "The AI agent can read this copy, even though AI access to Google Calendar is off. Your original Google event stays private to the agent."

    // MARK: Peek, search

    static let openDay = "Open day"
    static func itemCount(_ count: Int) -> String { count == 1 ? "1 item" : "\(count) items" }

    // MARK: Timeline (`timeline.*`)

    static let zoom = "Zoom"
    static func zoom(_ zoom: TimelineZoom) -> String {
        switch zoom {
        case .weeks: "Weeks"
        case .months: "Months"
        case .quarters: "Quarters"
        }
    }

    static let timelineEmptyTitle = "Nothing on the timeline here"
    static let timelineEmptyBody = "Tasks with a start or due date, and all-day or multi-day events, appear here. Turn on tasks without dates in Display to plan them."
    static let untitled = "Untitled"
    static let timelineEvents = "Events"
    static let timelineTasks = "Tasks"
    static let timelineNoDate = "No date"
    static let timelineScheduleHint = "Tap a day to set a date"
    static let timelineOverdue = "overdue"

    static func timelineStatus(_ status: String) -> String {
        switch status {
        case "in_progress": "In progress"
        case "done": "Done"
        default: "To do"
        }
    }

    static func timelinePriority(_ priority: Int64) -> String {
        switch priority {
        case 4: "Urgent"
        case 3: "High"
        case 2: "Medium"
        case 1: "Low"
        default: "No priority"
        }
    }

    static func dayText(_ key: String) -> String {
        CalendarDates.start(of: key).formatted(.dateTime.month(.abbreviated).day())
    }

    static func timelineSpan(_ start: String, _ end: String) -> String { "\(dayText(start)) – \(dayText(end))" }
    static func timelineDue(_ date: String) -> String { "Due \(dayText(date))" }
    static func timelineStarts(_ date: String) -> String { "Starts \(dayText(date))" }
    static func timelineReschedule(_ title: String) -> String { "Reschedule \"\(title)\"" }

    static let groupBy = "Group by"
    static let orderBy = "Order by"
    static let show = "Show"
    static let display = "Display"
    static let showEvents = "Events"
    static let showUndated = "Tasks without dates"
    static let showCompleted = "Completed tasks"
    static let showSubtasks = "Subtasks"

    /// Paper 07: "By project · 7 tasks · 1 event".
    static func timelineSummary(_ groupBy: TimelineGroupBy, tasks: Int, events: Int) -> String {
        let grouping = switch groupBy {
        case .project: "By project"
        case .status: "By status"
        case .priority: "By priority"
        case .none: "All tasks"
        }
        var parts = [grouping, tasks == 1 ? "1 task" : "\(tasks) tasks"]
        if events > 0 { parts.append(events == 1 ? "1 event" : "\(events) events") }
        return parts.joined(separator: " · ")
    }

    static func groupBy(_ value: TimelineGroupBy) -> String {
        switch value {
        case .project: "Project"
        case .status: "Status"
        case .priority: "Priority"
        case .none: "No grouping"
        }
    }

    static func orderBy(_ value: TimelineOrderBy) -> String {
        switch value {
        case .start: "Start date"
        case .due: "Due date"
        case .title: "Title"
        }
    }

    static let moveWeekEarlier = "1 week earlier"
    static let moveWeekLater = "1 week later"
    static let complete = "Complete"
    static let uncomplete = "Reopen"
    static let openTask = "Open task"
    static let openInTasks = "Open in Tasks"
    static let setStart = "Set start date…"
    static let setDue = "Set due date…"
    static func dayCount(_ days: Int) -> String { days == 1 ? "1 day" : "\(days) days" }
    static let changeProject = "Change project"
    static let clearDates = "Clear dates"

    // MARK: Task sheet (17, `task-popover.*`)

    static let taskKind = "Task"
    static let move = "Move"
    static let laterToday = "Later"
    static let tomorrow = "Tomorrow"
    static let nextWeek = "Next week"
    static let sourceNote = "Source note"
    static let pickDateTime = "Pick date & time…"
    static let removeDueDate = "Remove due date"
    static let markDone = "Mark done"
    static let markNotDone = "Mark not done"
    static let moreActions = "More actions"
    static let subtasks = "Subtasks"
    static func subtasksCounter(_ done: Int, _ total: Int) -> String { "\(done) of \(total) done" }

    // MARK: Note, snooze, reminder (20, 21)

    static let noteKind = "Note"
    static let dateReminderKind = "Date reminder"
    static let openNote = "Open note"
    static let snoozeKind = "Snoozed inbox item"
    static let openInInbox = "Open in inbox"
    static let unsnoozeNow = "Unsnooze now"
    static let reschedule = "Reschedule"
    static let reminderKind = "Reminder"
    static func backAt(_ time: String) -> String { "Back at \(time)" }

    // MARK: Event sheets (14, 19, `metadata.*`, `subscribedEvent.*`)

    static let eventKind = "Event"
    static let readOnly = "Read-only"
    static let subscribedKind = "Subscribed calendar"
    static let thisIPhone = "This iPhone"
    static let joinMeeting = "Join meeting"
    static let joinByPhone = "Join by phone"
    static let attendees = "Attendees"
    static let reminders = "Reminders"
    static let defaultReminders = "Default reminders"
    static let visibility = "Visibility"
    static let showMore = "Show more"
    static let showLess = "Show less"
    static let organizer = "organizer"
    static let detailsFailed = "Could not load the attendees and links for this event. The event itself is unchanged."
    static let location = "Location"
    static let notes = "Notes"
    static func changeItIn(_ place: String) -> String { "To change it, edit it in \(place)." }

    static func response(_ value: String) -> String {
        switch value {
        case "accepted": "Accepted"
        case "declined": "Declined"
        case "tentative": "Tentative"
        default: "Pending"
        }
    }

    static func visibilityValue(_ value: String) -> String {
        switch value {
        case "private": "Private"
        case "public": "Public"
        case "confidential": "Confidential"
        default: "Default"
        }
    }

    /// `subscribedEvent.alert*`.
    static func alert(minutes: Int) -> String {
        if minutes == 0 { return "Alert at start time" }
        if minutes % 1440 == 0 { let d = minutes / 1440; return d == 1 ? "Alert 1 day before" : "Alert \(d) days before" }
        if minutes % 60 == 0 { let h = minutes / 60; return h == 1 ? "Alert 1 hour before" : "Alert \(h) hours before" }
        return minutes == 1 ? "Alert 1 minute before" : "Alert \(minutes) minutes before"
    }

    // MARK: Editor (13, `form.*`)

    static let newEventTitle = "New Event"
    static let editEventTitle = "Edit Event"
    static let titlePlaceholder = "New Event"
    static let notesPlaceholder = "Add notes or URL"
    static let starts = "Starts"
    static let ends = "Ends"
    static let calendar = "Calendar"
    static let project = "Project"
    static let noProject = "No project"
    static let color = "Color"
    static let defaultColor = "Default color"
    static let useDefaultCalendar = "Use default calendar"
    static let memryCalendarDefault = "Use memrynote calendar (default)"
    static func removeFrom(_ project: String) -> String { "Remove from \(project)" }
    static let searchProjects = "Search projects…"

    static func colorName(_ name: String) -> String { name.prefix(1).uppercased() + name.dropFirst() }
}
