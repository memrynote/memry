import Foundation

// TP053. The reminder strings, mirroring desktop's `tasks.json` `reminders.*`,
// `inbox.json` `reminder.*` / `phaseF.componentsReminderReminderPicker.*` and
// `system.json` `notification.reminder.*`. Every name starts with `reminder`
// so no other block's extension can collide with it.

extension TasksCopy {
    // MARK: Section (`tasks.json` `task.reminder`, `reminders.*`)

    static let reminderSectionTitle = "Reminder"
    static let reminderSet = "Set reminder"
    static let reminderNone = "No reminders"

    static func reminderSummary(_ date: String, more: Int) -> String {
        more > 0 ? "Reminder: \(date) (+\(more) more)" : "Reminder: \(date)"
    }

    static let reminderToastSet = "Reminder set"
    static let reminderToastUpdated = "Reminder updated"
    static let reminderToastDeleted = "Reminder deleted"
    static let reminderToastDismissed = "Reminder dismissed"
    static let reminderToastSnoozed = "Reminder snoozed"

    // MARK: Picker (`phaseF.componentsReminderReminderPicker.*`)

    static let reminderRemindMe = "Remind me"
    static let reminderPickDateTime = "Pick date & time"
    static let reminderNotePlaceholder = "Add a note (optional)"
    static let reminderNoteLabel = "Note (optional)"
    static let reminderNoteHint = "Why are you setting this reminder?"
    static let reminderBackToPresets = "Back to presets"
    static let reminderTime = "Time"
    static let reminderDate = "Date"
    static let reminderEdit = "Edit reminder"
    static let reminderDelete = "Delete reminder"
    static let reminderSave = "Save"
    static let reminderCancel = "Cancel"
    static let reminderActions = "Reminder actions"

    // MARK: Presets (`inbox.json` `reminder.presets.*`)

    static let reminderPresetLaterToday = "Later Today"
    static func reminderPresetInHours(_ count: Int) -> String { count == 1 ? "In 1 hour" : "In \(count) hours" }
    static let reminderPresetTomorrow = "Tomorrow"
    static let reminderPresetTomorrowDetail = "Tomorrow at 9 AM"
    static let reminderPresetNextWeek = "Next Week"
    static let reminderPresetNextWeekDetail = "Monday at 9 AM"
    static let reminderPresetInOneMonth = "In 1 Month"
    static let reminderPresetSameDayNextMonth = "Same day next month"

    // MARK: Snooze (`inbox.json` `reminder.snooze`, reminder snooze presets)

    static let reminderSnooze = "Snooze"
    static let reminderDismiss = "Dismiss"
    static func reminderSnoozeInMinutes(_ count: Int) -> String { "In \(count) Minutes" }
    static func reminderSnoozeInHours(_ count: Int) -> String { count == 1 ? "In 1 Hour" : "In \(count) Hours" }
    static let reminderSnoozeTomorrowMorning = "Tomorrow Morning"

    // MARK: Dates (`inbox.json` `reminder.dateTime.*`)

    static func reminderTodayAt(_ time: String) -> String { "Today at \(time)" }
    static func reminderTomorrowAt(_ time: String) -> String { "Tomorrow at \(time)" }
    static func reminderDateAt(_ date: String, _ time: String) -> String { "\(date) at \(time)" }
    static let reminderPast = "Past due"
    static let reminderSnoozedState = "Snoozed"

    // MARK: Notifications (`system.json` `notification.reminder.*`)

    static let reminderNotificationDefault = "Reminder"

    static func reminderNotificationBody(targetType: String) -> String {
        switch targetType {
        case "task": "Task reminder"
        case "note": "Note reminder"
        case "journal": "Journal reminder"
        case "highlight": "Highlight reminder"
        default: "Reminder due"
        }
    }

    // MARK: Platform limits (FR-062)

    static func reminderWindowLimit(_ window: Int, beyond: Int) -> String {
        "This phone holds the next \(window) reminders at a time. "
            + "\(beyond) later \(beyond == 1 ? "one is" : "ones are") scheduled as earlier ones fire, "
            + "each time Memry opens."
    }

    static let reminderNotificationsOff =
        "Notifications are off for Memry, so reminders will not alert on this phone."
    static let reminderOpenSettings = "Open Settings"

    // MARK: More tab

    static let reminderMoreTasksRow = "Tasks"
    static let reminderMoreTasksDetail = "Default project, sort, view and stale inbox days"
}
