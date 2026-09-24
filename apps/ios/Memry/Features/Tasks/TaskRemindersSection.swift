import MemryCore
import SwiftUI

// TP053. A task's reminders in its detail screen, after desktop's
// `task-reminder-button.tsx` + `reminder-picker.tsx`: every active reminder
// (pending or snoozed) with edit, snooze, dismiss and delete; "Set reminder"
// opens the preset / custom date & time picker. Multiple reminders per task.
//
// Below the list the section says what the platform limits: notifications
// switched off for Memry, or more reminders than the phone holds at once
// (FR-062).

/// TP053 — a task's reminders.
struct TaskRemindersSection: View {
    let task: TaskItem
    let store: TasksStore
    var scheduler: ReminderScheduler = .shared

    @State private var reminders: [ReminderItem] = []
    @State private var picker: TaskReminderPickerMode?
    @State private var version = 0
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Label(TasksCopy.reminderSectionTitle, systemImage: "bell")
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityAddTraits(.isHeader)
            ForEach(reminders, id: \.id) { reminder in
                TaskReminderRow(
                    reminder: reminder,
                    now: store.clock(),
                    onEdit: { picker = .edit(reminder) },
                    onSnooze: { date in write { await store.snoozeReminder(reminder.id, until: date) } },
                    onDismiss: { write { await store.dismissReminder(reminder.id) } },
                    onDelete: { write { await store.deleteReminder(reminder.id) } }
                )
            }
            Button {
                picker = .add
            } label: {
                Label(TasksCopy.reminderSet, systemImage: "bell.badge")
                    .font(Tokens.Typography.body.font)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.Text.tint.color)
            .accessibilityIdentifier("tasks.reminders.add")
            limits
        }
        .task(id: ReloadKey(task: task, version: version, syncing: store.isSyncing)) {
            reminders = await store.activeReminders(of: task.id)
        }
        .sheet(item: $picker) { mode in
            TaskReminderPickerSheet(mode: mode, now: store.clock()) { date, note in
                picker = nil
                write {
                    switch mode {
                    case .add: await store.addReminder(to: task.id, at: date, note: note)
                    case let .edit(reminder): await store.rescheduleReminder(reminder.id, to: date)
                    }
                }
            }
        }
    }

    @ViewBuilder private var limits: some View {
        if scheduler.authorization == .denied, !reminders.isEmpty {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(TasksCopy.reminderNotificationsOff)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Button(TasksCopy.reminderOpenSettings) {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
                .font(Tokens.Typography.caption.font)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.reminders.openSettings")
            }
        }
        if scheduler.beyondWindow > 0 {
            Text(TasksCopy.reminderWindowLimit(ReminderSchedulePlan.window, beyond: scheduler.beyondWindow))
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityIdentifier("tasks.reminders.windowLimit")
        }
    }

    private func write(_ work: @escaping @MainActor () async -> Void) {
        Task {
            await work()
            version += 1
        }
    }

    private struct ReloadKey: Hashable {
        let task: TaskItem
        let version: Int
        let syncing: Bool
    }
}

/// One reminder: when it fires, its note, and its actions.
struct TaskReminderRow: View {
    let reminder: ReminderItem
    let now: Date
    let onEdit: () -> Void
    let onSnooze: (Date) -> Void
    let onDismiss: () -> Void
    let onDelete: () -> Void

    private var isSnoozed: Bool { reminder.status == "snoozed" }

    private var fireAt: Date? {
        if isSnoozed, let until = reminder.snoozedUntil, let date = TaskReminderPresets.instant(until) {
            return date
        }
        return TaskReminderPresets.instant(reminder.remindAt)
    }

    private var isPast: Bool { (fireAt ?? now) <= now }

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Label {
                    Text(fireAt.map { TaskReminderPresets.text($0, now: now) } ?? reminder.remindAt)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(isPast ? Tokens.Task.dueOverdue.color : Tokens.Text.primary.color)
                } icon: {
                    Image(systemName: isPast ? "bell.badge" : "bell.fill")
                        .foregroundStyle(isPast ? Tokens.Task.dueOverdue.color : Tokens.Task.dueToday.color)
                }
                if isPast || isSnoozed {
                    Text(isPast ? TasksCopy.reminderPast : TasksCopy.reminderSnoozedState)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                if let note = reminder.note, !note.isEmpty {
                    Text(note)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityAction(named: TasksCopy.reminderEdit, onEdit)
            .accessibilityAction(named: TasksCopy.reminderDismiss, onDismiss)
            .accessibilityAction(named: TasksCopy.reminderDelete, onDelete)
            actions
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("tasks.reminders.row")
    }

    private var actions: some View {
        Menu {
            Button(TasksCopy.reminderEdit, systemImage: "pencil", action: onEdit)
                .accessibilityIdentifier("tasks.reminders.edit")
            Menu(TasksCopy.reminderSnooze, systemImage: "moon.zzz") {
                ForEach(TaskReminderPresets.snooze(now: now)) { preset in
                    Button(preset.label) { onSnooze(preset.date) }
                        .accessibilityIdentifier("tasks.reminders.snooze.\(preset.id)")
                }
            }
            .accessibilityIdentifier("tasks.reminders.snooze")
            Button(TasksCopy.reminderDismiss, systemImage: "bell.slash", action: onDismiss)
                .accessibilityIdentifier("tasks.reminders.dismiss")
            Button(TasksCopy.reminderDelete, systemImage: "trash", role: .destructive, action: onDelete)
                .accessibilityIdentifier("tasks.reminders.delete")
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(TasksCopy.reminderActions)
        .accessibilityIdentifier("tasks.reminders.actions")
    }
}
