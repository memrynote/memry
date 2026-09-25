import MemryCore
import SwiftUI

// TP053. The reminder picker, after desktop's `reminder-picker.tsx`: the
// standard presets with their descriptions and an optional note, or a
// custom date and time. Editing an existing reminder opens straight on the
// date and time, prefilled.
//
// The core refuses a time that is not in the future (desktop's
// `reminderTimeMustBeFuture`); the date picker starts at now so the phone
// rarely offers one.

/// What the picker is for.
enum TaskReminderPickerMode: Identifiable, Equatable {
    case add
    case edit(ReminderItem)

    var id: String {
        switch self {
        case .add: "add"
        case let .edit(reminder): "edit-\(reminder.id)"
        }
    }
}

struct TaskReminderPickerSheet: View {
    let mode: TaskReminderPickerMode
    let now: Date
    /// The chosen instant and the note (nil when empty or when editing).
    let onChoose: (Date, String?) -> Void

    @State private var custom = false
    @State private var date = Date()
    @State private var note = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if custom || isEditing {
                    customForm
                } else {
                    presetList
                }
            }
            .navigationTitle(isEditing ? TasksCopy.reminderEdit : TasksCopy.reminderSet)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("tasks.reminders.cancel")
                }
                if custom || isEditing {
                    ToolbarItem(placement: .confirmationAction) {
                        SheetConfirmButton(label: isEditing ? TasksCopy.reminderSave : TasksCopy.reminderSet) {
                            onChoose(date, isEditing ? nil : note)
                        }
                        .disabled(date <= now)
                        .accessibilityIdentifier("tasks.reminders.confirm")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear(perform: prefill)
    }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var presetList: some View {
        List {
            Section(TasksCopy.reminderRemindMe) {
                ForEach(TaskReminderPresets.standard(now: now)) { preset in
                    Button {
                        onChoose(preset.date, note)
                    } label: {
                        HStack {
                            Text(preset.label)
                                .foregroundStyle(Tokens.Text.primary.color)
                            Spacer(minLength: Tokens.Space.small)
                            if let detail = preset.detail {
                                Text(detail)
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                            }
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .accessibilityHint(TaskReminderPresets.text(preset.date, now: now))
                    .accessibilityIdentifier("tasks.reminders.preset.\(preset.id)")
                }
            }
            Section {
                Button {
                    custom = true
                } label: {
                    Label(TasksCopy.reminderPickDateTime, systemImage: "calendar")
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                        .contentShape(.rect)
                }
                .accessibilityIdentifier("tasks.reminders.pickDateTime")
            }
            Section {
                TextField(TasksCopy.reminderNotePlaceholder, text: $note, axis: .vertical)
                    .lineLimit(2 ... 4)
                    .accessibilityIdentifier("tasks.reminders.note")
            }
        }
    }

    private var customForm: some View {
        Form {
            Section {
                DatePicker(
                    TasksCopy.reminderDate,
                    selection: $date,
                    in: now...,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .datePickerStyle(.graphical)
                .tint(Tokens.Text.tint.color)
                .accessibilityIdentifier("tasks.reminders.datePicker")
            } footer: {
                Text(TaskReminderPresets.text(date, now: now))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            if !isEditing {
                Section(TasksCopy.reminderNoteLabel) {
                    TextField(TasksCopy.reminderNoteHint, text: $note, axis: .vertical)
                        .lineLimit(2 ... 4)
                        .accessibilityIdentifier("tasks.reminders.customNote")
                }
                Section {
                    Button(TasksCopy.reminderBackToPresets) { custom = false }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.reminders.backToPresets")
                }
            }
        }
    }

    /// Editing starts on the reminder's time; a new custom time on tomorrow
    /// 9 AM (desktop's picker defaults the time to 09:00).
    private func prefill() {
        if case let .edit(reminder) = mode,
           let current = TaskReminderPresets.instant(reminder.remindAt),
           current > now {
            date = current
        } else {
            date = TaskReminderPresets.inDays(1, hour: 9, from: now)
        }
    }
}
