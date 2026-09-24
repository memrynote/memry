import MemryCore
import SwiftUI

// RD11. The When sheet's pieces: the natural-language field (dates from the
// core's date parser, repeats such as "every thu 3pm" from its quick-add
// grammar, D1), and the pages its rows push: Repeat (desktop's presets, the
// custom editor, repeat-from), Remind me (a task's reminder list with edit,
// snooze, dismiss and delete, or the composer's one reminder) and Start date.

/// What the field read: any of a date, a time and a rule.
struct TaskWhenReading: Equatable {
    var date: String?
    var time: String?
    var rule: RepeatRule?
    /// The resolved value, e.g. "Weekly · Thu 15:00".
    var display: String
}

extension TasksStore {
    /// A date phrase ("next friday 3pm") through the date parser, else a
    /// repeat phrase ("every thu 3pm") through the quick-add grammar.
    func whenReading(_ input: String) async -> TaskWhenReading? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let parsed = parsedDate(trimmed) {
            return TaskWhenReading(date: parsed.date, time: parsed.time, rule: nil, display: parsed.displayText)
        }
        guard let parse = await parseQuickAdd(trimmed), let rule = parse.repeat else { return nil }
        let time = parse.dueDate == nil ? nil : parse.dueTime
        var parts = [TasksCopy.Detail.repeatSummary(frequency: rule.frequency, interval: rule.interval)]
        let day = parse.dueDate.map(TasksCopy.shortWeekday)
        let clock = time.flatMap(TaskDueLabel.prettyTime)
        let when = [day, clock].compactMap { $0 }.joined(separator: " ")
        if !when.isEmpty { parts.append(when) }
        return TaskWhenReading(
            date: parse.dueDate, time: time, rule: rule, display: parts.joined(separator: TasksCopy.subtitleSeparator)
        )
    }
}

/// "every thu 3pm" → "Weekly · Thu 15:00", applied on Return.
struct TaskWhenNaturalField: View {
    let store: TasksStore
    let onApply: (TaskWhenReading) -> Void

    @State private var query = ""
    @State private var reading: TaskWhenReading?

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "sparkles")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            TextField(TasksCopy.whenNaturalPlaceholder, text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(apply)
                .accessibilityLabel(TasksCopy.naturalDateLabel)
                .accessibilityIdentifier("tasks.when.natural")
            if let reading {
                Button(reading.display, action: apply)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tint.color)
                    .buttonStyle(.plain)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityHint(TasksCopy.whenApplyHint)
                    .accessibilityIdentifier("tasks.when.naturalResult")
            } else if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(TasksCopy.naturalDateNotUnderstood)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .lineLimit(2)
            }
        }
        .font(Tokens.Typography.body.font)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .task(id: query) {
            let value = query
            let read = await store.whenReading(value)
            guard !Task.isCancelled, value == query else { return }
            reading = read
        }
    }

    private func apply() {
        guard let reading else { return }
        onApply(reading)
        query = ""
    }
}

/// Repeat: never, desktop's presets on the date, custom, repeat-from.
struct TaskWhenRepeatPage: View {
    let store: TasksStore
    let taskId: String?
    let anchorDate: String?
    let original: RepeatChoice
    @Binding var rule: RepeatRule?
    @Binding var repeatFrom: String?
    @Binding var touched: Bool

    var body: some View {
        List {
            Section {
                row(TasksCopy.doesNotRepeat, selected: touched ? rule == nil : !wasRepeating, id: "none") {
                    choose(nil)
                }
                ForEach(store.repeatPresets(anchorDate: anchorDate)) { preset in
                    row(TasksCopy.repeatPresetLabel(preset), selected: matches(preset), id: preset.id) {
                        choose(preset.rule)
                    }
                }
            }
            Section {
                NavigationLink {
                    RepeatCustomEditor(initial: rule ?? original.rule, anchorDate: anchorDate, store: store) {
                        choose($0)
                    }
                } label: {
                    Text(TasksCopy.customRepeatRow)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.repeat.custom")
            }
            if rule != nil {
                Section(TasksCopy.repeatFromTitle) {
                    Picker(TasksCopy.repeatFromTitle, selection: Binding(
                        get: { repeatFrom ?? "due" },
                        set: { value in
                            touched = true
                            // Desktop writes no anchor for "due"; keep it absent unless it was set.
                            repeatFrom = value == "due" && original.repeatFrom == nil ? nil : value
                        }
                    )) {
                        Text(TasksCopy.repeatFromDue).tag("due")
                        Text(TasksCopy.repeatFromCompletion).tag("completion")
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier("tasks.repeat.from")
                }
            }
        }
        .font(Tokens.Typography.body.font)
        .navigationTitle(TasksCopy.repeatTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var wasRepeating: Bool { original.rule != nil || store.isRepeating(taskId) }

    private func matches(_ preset: RepeatPreset) -> Bool {
        rule.map { TasksCopy.repeatSummary($0) == TasksCopy.repeatSummary(preset.rule) } ?? false
    }

    private func choose(_ next: RepeatRule?) {
        touched = true
        // A preset equal to the current rule keeps it, count and creation included.
        if let next, let current = original.rule, TasksCopy.repeatSummary(current) == TasksCopy.repeatSummary(next) {
            rule = current
        } else {
            rule = next
        }
    }

    private func row(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: Tokens.Space.small)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("tasks.repeat.preset.\(id)")
    }
}

/// Remind me: a task's reminder list, or the composer's one reminder.
struct TaskWhenReminderPage: View {
    let store: TasksStore
    let task: TaskItem?
    @Binding var reminder: Date?

    var body: some View {
        Form {
            if let task {
                Section { TaskRemindersSection(task: task, store: store) }
            } else {
                Section(TasksCopy.reminderRemindMe) {
                    ForEach(TaskReminderPresets.standard(now: store.clock())) { preset in
                        Button {
                            reminder = preset.date
                        } label: {
                            LabeledContent(preset.label, value: preset.detail ?? "")
                                .foregroundStyle(Tokens.Text.primary.color)
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.when.reminder.\(preset.id)")
                    }
                }
                Section {
                    DatePicker(
                        TasksCopy.reminderDate,
                        selection: Binding(
                            get: { reminder ?? TaskReminderPresets.inDays(1, hour: 9, from: store.clock()) },
                            set: { reminder = $0 }
                        ),
                        in: store.clock()...,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .accessibilityIdentifier("tasks.when.reminder.custom")
                    if reminder != nil {
                        Button(TasksCopy.composerNoReminder, role: .destructive) { reminder = nil }
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                    }
                } footer: {
                    if let reminder {
                        Text(TaskReminderPresets.text(reminder, now: store.clock()))
                    }
                }
            }
        }
        .navigationTitle(TasksCopy.whenRemindMe)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Start date: a calendar and "Remove start date".
struct TaskWhenStartPage: View {
    let store: TasksStore
    @Binding var startDate: String?

    var body: some View {
        Form {
            Section {
                DatePicker(
                    TasksCopy.fieldStartDate,
                    selection: Binding(
                        get: { startDate.flatMap(TaskDates.date) ?? store.clock() },
                        set: { startDate = TaskDates.key($0) }
                    ),
                    displayedComponents: .date
                )
                .datePickerStyle(.graphical)
                .accessibilityIdentifier("tasks.when.start.calendar")
            }
            if startDate != nil {
                Section {
                    Button(TasksCopy.whenRemoveStart, role: .destructive) { startDate = nil }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.when.start.remove")
                }
            }
        }
        .navigationTitle(TasksCopy.fieldStartDate)
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension TasksCopy {
    static let whenNaturalPlaceholder = "“next fri 3pm”, “every thu”"
    static let whenApplyHint = "Applies this date and repeat"
    static let whenRemoveStart = "Remove start date"
}
