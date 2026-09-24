import Foundation
import MemryCore

// TP053. A task's reminder operations over the core (desktop
// `use-task-reminders.ts`). Each write refreshes and syncs through
// ``TasksStore/run(_:)``, then refills the notification window so the phone
// alerts at the new time (FR-062). Adding the first reminder is when the app
// asks for notification permission, never at launch.

extension TasksStore {
    /// A task's pending and snoozed reminders, earliest first (desktop
    /// `activeReminders`).
    func activeReminders(of taskId: String) async -> [ReminderItem] {
        await read { try $0.taskReminders(taskId: taskId, activeOnly: true) } ?? []
    }

    /// Adds a reminder at `date` with an optional note; returns its id.
    @discardableResult
    func addReminder(
        to taskId: String,
        at date: Date,
        note: String?,
        scheduler: ReminderScheduler = .shared
    ) async -> String? {
        let remindAt = TaskDates.iso(date)
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = trimmed?.isEmpty == false ? trimmed : nil
        let id = await run { try $0.addTaskReminder(taskId: taskId, remindAt: remindAt, title: nil, note: note) }
        guard id != nil else { return nil }
        confirm(TasksCopy.reminderToastSet)
        await scheduler.requestPermissionIfNeeded()
        await scheduler.refill(from: self)
        return id
    }

    /// Reschedules a reminder (it becomes pending again, as desktop's
    /// `updateReminder` does).
    @discardableResult
    func rescheduleReminder(_ id: String, to date: Date, scheduler: ReminderScheduler = .shared) async -> Bool {
        let remindAt = TaskDates.iso(date)
        return await reminderWrite(id, TasksCopy.reminderToastUpdated, scheduler) {
            try $0.updateReminder(id: id, remindAt: remindAt, title: nil)
        }
    }

    @discardableResult
    func deleteReminder(_ id: String, scheduler: ReminderScheduler = .shared) async -> Bool {
        await reminderWrite(id, TasksCopy.reminderToastDeleted, scheduler) { try $0.deleteReminder(id: id) }
    }

    @discardableResult
    func dismissReminder(_ id: String, scheduler: ReminderScheduler = .shared) async -> Bool {
        await reminderWrite(id, TasksCopy.reminderToastDismissed, scheduler) { try $0.dismissReminder(id: id) }
    }

    @discardableResult
    func snoozeReminder(_ id: String, until date: Date, scheduler: ReminderScheduler = .shared) async -> Bool {
        let until = TaskDates.iso(date)
        return await reminderWrite(id, TasksCopy.reminderToastSnoozed, scheduler) {
            try $0.snoozeReminder(id: id, until: until)
        }
    }

    private func reminderWrite(
        _ id: String,
        _ message: String,
        _ scheduler: ReminderScheduler,
        _ work: @escaping @Sendable (any TasksProtocol) throws -> Void
    ) async -> Bool {
        guard await run(work) != nil else { return false }
        confirm(message)
        scheduler.forget(reminderId: id)
        await scheduler.refill(from: self)
        return true
    }

    /// A toast with no Undo: the reminder surface has no core undo, so an
    /// older task change must not stay attached to this toast.
    private func confirm(_ message: String) {
        undoable = nil
        toast = message
    }
}
