import Foundation
import MemryCore

// JP046, D8. A day's reminder operations over the core (desktop
// `use-journal-reminders.ts`). A reminder targets the date, never the record
// id, and never creates the day.
//
// **One reminder per day** (`use-set-or-replace-reminder.ts:28-45`):
// ``setReminder(on:at:note:tasks:scheduler:)`` moves the day's next active
// reminder, or creates one when there is none; the core does the choosing
// (`Journal.setReminder`). Reminders written elsewhere are listed and each
// can be edited, snoozed, dismissed or deleted by id.
//
// Every write re-reads the day's reminders, then refills the notification
// window through the vault's tasks store (the scheduler reads every due
// reminder from there). The first reminder asks for notification
// permission, never at launch.

extension JournalStore {
    /// The day's pending and snoozed reminders, earliest first (the core's
    /// order). Empty until ``loadReminders(_:)`` has read the day.
    func activeReminders(_ date: String) -> [JournalReminder] {
        (reminders[date] ?? []).filter(\.isActive)
    }

    /// Sets the day's reminder at `instant`, moving the active one when the
    /// day has it. Returns the reminder id written.
    @discardableResult
    func setReminder(
        on date: String,
        at instant: Date,
        note: String?,
        tasks: TasksStore?,
        scheduler: ReminderScheduler = .shared
    ) async -> String? {
        if reminders[date] == nil { await loadReminders(date) }
        let before = Set(activeReminders(date).map(\.id))
        let remindAt = TaskDates.iso(instant)
        let note = Self.reminderNote(note)
        guard let id = await perform(date: date, { try $0.setReminder(date: date, remindAt: remindAt, note: note) })
        else { return nil }
        await loadReminders(date)
        let moved = before.contains(id)
        toast = moved ? JournalCopy.reminderUpdated : JournalCopy.reminderSet
        if moved { scheduler.forget(reminderId: id) }
        await scheduler.requestPermissionIfNeeded()
        if let tasks { scheduler.scheduleRefill(from: tasks) }
        return id
    }

    /// Edits one reminder's time and note (an empty note clears it).
    @discardableResult
    func updateReminder(
        _ reminder: JournalReminder,
        at instant: Date,
        note: String?,
        tasks: TasksStore?,
        scheduler: ReminderScheduler = .shared
    ) async -> Bool {
        let id = reminder.id
        let remindAt = TaskDates.iso(instant)
        let note = Self.reminderNote(note)
        return await reminderWrite(reminder, JournalCopy.reminderUpdated, tasks, scheduler) {
            try $0.updateReminder(id: id, remindAt: remindAt, note: note)
        }
    }

    @discardableResult
    func snoozeReminder(
        _ reminder: JournalReminder,
        until instant: Date,
        tasks: TasksStore?,
        scheduler: ReminderScheduler = .shared
    ) async -> Bool {
        let id = reminder.id
        let until = TaskDates.iso(instant)
        return await reminderWrite(reminder, JournalCopy.reminderSnoozed, tasks, scheduler) {
            try $0.snoozeReminder(id: id, until: until)
        }
    }

    @discardableResult
    func dismissReminder(
        _ reminder: JournalReminder,
        tasks: TasksStore?,
        scheduler: ReminderScheduler = .shared
    ) async -> Bool {
        let id = reminder.id
        return await reminderWrite(reminder, JournalCopy.reminderDismissed, tasks, scheduler) {
            try $0.dismissReminder(id: id)
        }
    }

    @discardableResult
    func deleteReminder(
        _ reminder: JournalReminder,
        tasks: TasksStore?,
        scheduler: ReminderScheduler = .shared
    ) async -> Bool {
        let id = reminder.id
        return await reminderWrite(reminder, JournalCopy.reminderDeleted, tasks, scheduler) {
            try $0.deleteReminder(id: id)
        }
    }

    private func reminderWrite(
        _ reminder: JournalReminder,
        _ message: String,
        _ tasks: TasksStore?,
        _ scheduler: ReminderScheduler,
        _ work: @escaping @Sendable (any JournalProtocol) throws -> Void
    ) async -> Bool {
        guard await perform(date: reminder.date, work) != nil else { return false }
        await loadReminders(reminder.date)
        toast = message
        scheduler.forget(reminderId: reminder.id)
        if let tasks { scheduler.scheduleRefill(from: tasks) }
        return true
    }

    /// Desktop writes an empty note as `null`.
    private static func reminderNote(_ note: String?) -> String? {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
