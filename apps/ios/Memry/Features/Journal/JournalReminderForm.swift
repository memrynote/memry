import SwiftUI

// JP046 (J07, J08). The date, time and note rows the reminder sheets share,
// and the sheet that holds only them: "Pick date & time…" from the bell menu,
// and editing one reminder from the J08 list.
//
// The core refuses a time that is not in the future, so the date starts at
// today and the confirm button stays off until the time is ahead of now.

/// Date, time and optional note rows (J08 "Change reminder").
struct JournalReminderFormRows: View {
    @Binding var when: Date
    @Binding var note: String
    let now: Date

    var body: some View {
        DatePicker(
            JournalCopy.reminderDate,
            selection: $when,
            in: JournalDates.calendar.startOfDay(for: now)...,
            displayedComponents: .date
        )
        .tint(Tokens.Text.tint.color)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("journal.reminder.date")
        DatePicker(JournalCopy.reminderTime, selection: $when, displayedComponents: .hourAndMinute)
            .tint(Tokens.Text.tint.color)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("journal.reminder.time")
        LabeledContent(JournalCopy.reminderNote) {
            TextField(JournalCopy.reminderNoteOptional, text: $note, axis: .vertical)
                .multilineTextAlignment(.trailing)
                .lineLimit(1 ... 4)
                .accessibilityLabel(JournalCopy.reminderNote)
                .accessibilityIdentifier("journal.reminder.note")
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
    }
}

/// A sheet with only the date, time and note (J07 "Pick date & time…", and
/// editing one reminder from J08).
struct JournalReminderPickSheet: View {
    let title: String
    let initial: Date
    let initialNote: String
    let now: Date
    /// The chosen instant and note.
    let onChoose: (Date, String) -> Void

    @State private var when = Date()
    @State private var note = ""
    @State private var prefilled = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    JournalReminderFormRows(when: $when, note: $note, now: now)
                } footer: {
                    Text(JournalReminderPresets.text(when, now: now))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("journal.reminder.pick.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: JournalCopy.reminderSave, isEnabled: when > now) {
                        onChoose(when, note)
                    }
                    .accessibilityIdentifier("journal.reminder.pick.confirm")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            guard !prefilled else { return }
            prefilled = true
            when = initial
            note = initialNote
        }
    }
}
