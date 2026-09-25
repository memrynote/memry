import MemryCore
import SwiftUI

// JP046 (J08). The sheet an active bell opens, after desktop's reminder
// picker in its "has reminders" state (`journal-reminder-button.tsx`):
//
// * "Scheduled for this day": every active reminder of the day, earliest
//   first. Tap edits the time and note; swipe deletes (trailing) or
//   dismisses (leading); the context menu also snoozes.
// * "Change reminder": a date, a time and a note, prefilled with the next
//   reminder. Saving moves that reminder (set-or-replace, D8), it never adds
//   a second one.

struct JournalReminderSheet: View {
    let store: JournalStore
    let date: String
    let tasks: TasksStore?
    var scheduler: ReminderScheduler = .shared

    @State private var when = Date()
    @State private var note = ""
    @State private var editing: JournalReminderEdit?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var active: [JournalReminder] { store.activeReminders(date) }
    private var now: Date { store.clock.instant() }

    var body: some View {
        NavigationStack {
            Form {
                if !active.isEmpty {
                    Section(JournalCopy.scheduledForThisDay) {
                        ForEach(active, id: \.id) { reminder in
                            row(reminder)
                        }
                    }
                }
                Section {
                    JournalReminderFormRows(when: $when, note: $note, now: now)
                } header: {
                    Text(JournalCopy.changeReminder)
                } footer: {
                    footer
                }
            }
            .navigationTitle(JournalCopy.remindMe)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("journal.reminder.sheet.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    TaskSheetConfirmButton(label: JournalCopy.reminderSave, isEnabled: when > now) {
                        save()
                    }
                    .accessibilityIdentifier("journal.reminder.sheet.save")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear(perform: prefill)
        .sheet(item: $editing) { edit in
            JournalReminderPickSheet(
                title: TasksCopy.reminderEdit,
                initial: JournalReminderPresets.fireDate(edit.reminder) ?? JournalReminderPresets.inDays(1, from: now),
                initialNote: edit.reminder.note ?? "",
                now: now
            ) { instant, note in
                editing = nil
                Task { await store.updateReminder(edit.reminder, at: instant, note: note, tasks: tasks) }
            }
        }
    }

    private func row(_ reminder: JournalReminder) -> some View {
        Button {
            editing = JournalReminderEdit(reminder: reminder)
        } label: {
            HStack(spacing: Tokens.Space.medium) {
                Image(systemName: "bell.fill")
                    .foregroundStyle(Tokens.Text.tint.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    Text(JournalReminderPresets.fireDate(reminder).map { JournalReminderPresets.text($0, now: now) }
                        ?? reminder.remindAt)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                    if reminder.status == "snoozed" {
                        Text(JournalCopy.reminderSnoozedState)
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
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(TasksCopy.reminderEdit)
        .accessibilityAction(named: TasksCopy.reminderDismiss) { dismissReminder(reminder) }
        .accessibilityAction(named: TasksCopy.reminderDelete) { deleteReminder(reminder) }
        .accessibilityIdentifier("journal.reminder.row.\(reminder.id)")
        .swipeActions(edge: .trailing) {
            Button(TasksCopy.reminderDelete, systemImage: "trash", role: .destructive) { deleteReminder(reminder) }
                .accessibilityIdentifier("journal.reminder.delete")
        }
        .swipeActions(edge: .leading) {
            Button(TasksCopy.reminderDismiss, systemImage: "bell.slash") { dismissReminder(reminder) }
                .accessibilityIdentifier("journal.reminder.dismiss")
        }
        .contextMenu { actions(reminder) }
    }

    @ViewBuilder private func actions(_ reminder: JournalReminder) -> some View {
        Button(TasksCopy.reminderEdit, systemImage: "pencil") { editing = JournalReminderEdit(reminder: reminder) }
            .accessibilityIdentifier("journal.reminder.edit")
        Menu(TasksCopy.reminderSnooze, systemImage: "moon.zzz") {
            ForEach(TaskReminderPresets.snooze(now: now)) { preset in
                Button(preset.label) {
                    Task { await store.snoozeReminder(reminder, until: preset.date, tasks: tasks) }
                }
                .accessibilityIdentifier("journal.reminder.snooze.\(preset.id)")
            }
        }
        .accessibilityIdentifier("journal.reminder.snooze")
        Button(TasksCopy.reminderDismiss, systemImage: "bell.slash") { dismissReminder(reminder) }
        Button(TasksCopy.reminderDelete, systemImage: "trash", role: .destructive) { deleteReminder(reminder) }
    }

    @ViewBuilder private var footer: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(JournalCopy.reminderSheetFooter)
            if scheduler.authorization == .denied {
                Text(TasksCopy.reminderNotificationsOff)
                Button(TasksCopy.reminderOpenSettings) {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("journal.reminder.openSettings")
            }
        }
        .font(Tokens.Typography.caption.font)
        .foregroundStyle(Tokens.Text.secondary.color)
    }

    private func dismissReminder(_ reminder: JournalReminder) {
        Task { await store.dismissReminder(reminder, tasks: tasks) }
    }

    private func deleteReminder(_ reminder: JournalReminder) {
        Task { await store.deleteReminder(reminder, tasks: tasks) }
    }

    private func save() {
        let instant = when
        let note = note
        Task {
            if await store.setReminder(on: date, at: instant, note: note, tasks: tasks) != nil { dismiss() }
        }
    }

    /// The form starts on the next reminder's time and note, so saving
    /// without changes keeps both.
    private func prefill() {
        let next = active.first
        when = next.flatMap(JournalReminderPresets.fireDate).flatMap { $0 > now ? $0 : nil }
            ?? JournalReminderPresets.inDays(1, from: now)
        note = next?.note ?? ""
    }
}

/// One reminder opened for editing.
private struct JournalReminderEdit: Identifiable {
    let reminder: JournalReminder
    var id: String { reminder.id }
}
