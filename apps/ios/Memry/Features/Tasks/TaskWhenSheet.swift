import MemryCore
import SwiftUI

// RD11. The When sheet (Paper artboard 11): the one deeper level behind the
// When menu's "Pick date & time…" and the composer's "More fields…". A
// natural-language field whose resolved value reads live (dates, and repeats
// such as "every thu 3pm"), a graphical calendar, and grouped rows for Time,
// Repeat, Remind me and Start date. Close is an xmark, commit a prominent
// checkmark (iOS 26 `close` / `confirm` roles).
//
// It edits a draft and commits once. For a task that already repeats, a date
// or rule change asks the Edit Repeating or Stop Repeating question (TP045)
// after the sheet has gone; reminders on a task are written as they change
// (they have their own list, TP053).

/// Everything the When sheet edits.
struct TaskWhenDraft: Equatable {
    var date: String?
    var time: String?
    var rule: RepeatRule?
    var repeatFrom: String?
    var startDate: String?
    /// The composer's one reminder; a task's reminders are written directly.
    var reminder: Date?

    init(values: TaskComposerValues) {
        date = values.dueDate
        time = values.dueDate == nil ? nil : values.dueTime
        rule = values.rule
        repeatFrom = values.repeatFrom
        startDate = values.startDate
        reminder = values.reminder
    }

    init(task: TaskItem) {
        date = task.dueDate.map { String($0.prefix(10)) }
        time = task.dueDate == nil ? nil : task.dueTime
        rule = task.repeat
        repeatFrom = task.repeatFrom
        startDate = task.startDate.map { String($0.prefix(10)) }
        reminder = nil
    }
}

/// What the sheet edits: the composer's draft, or a task.
enum TaskWhenTarget {
    case draft(TaskWhenDraft)
    case task(TaskItem)
}

extension TaskComposerDraft {
    /// Takes the When sheet's answer; only what changed overrides the text.
    mutating func apply(_ when: TaskWhenDraft, from original: TaskWhenDraft) {
        if when.date != original.date || when.time != original.time {
            due = when.date.map { .set(date: $0, time: when.time) } ?? .cleared
        }
        if when.rule != original.rule || when.repeatFrom != original.repeatFrom {
            rule = when.rule.map { .set($0, repeatFrom: when.repeatFrom) } ?? .cleared
        }
        startDate = when.startDate
        reminder = when.reminder
    }
}

struct TaskWhenSheet: View {
    let store: TasksStore
    let target: TaskWhenTarget
    /// The draft target's answer; a task target writes through the store.
    var onCommit: (TaskWhenDraft, TaskWhenDraft) -> Void = { _, _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var draft: TaskWhenDraft
    @State private var ruleTouched = false
    @State private var raised: TasksPrompt?
    /// A task's live reminders, for the Remind me row's value.
    @State private var reminders: [ReminderItem] = []
    private let original: TaskWhenDraft

    init(store: TasksStore, target: TaskWhenTarget, onCommit: @escaping (TaskWhenDraft, TaskWhenDraft) -> Void = { _, _ in }) {
        self.store = store
        self.target = target
        self.onCommit = onCommit
        let start: TaskWhenDraft = switch target {
        case let .draft(value): value
        case let .task(task): TaskWhenDraft(task: task)
        }
        original = start
        _draft = State(initialValue: start)
    }

    private var task: TaskItem? {
        if case let .task(task) = target { return store.items[task.id] ?? task }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TaskWhenNaturalField(store: store) { reading in apply(reading) }
                }
                .listRowBackground(Tokens.Canvas.surface.color)
                Section {
                    DatePicker(
                        TasksCopy.pickADate,
                        selection: Binding(
                            get: { draft.date.flatMap(TaskDates.date) ?? store.clock() },
                            set: { draft.date = TaskDates.key($0) }
                        ),
                        displayedComponents: .date
                    )
                    .datePickerStyle(.graphical)
                    .labelsHidden()
                    // Rule 6: the selected day's fill carries white text, so
                    // it takes tint-ink (contrast), not the raw tint.
                    .tint(Tokens.Text.tint.color)
                    .environment(\.calendar, weekCalendar)
                    .accessibilityIdentifier("tasks.when.calendar")
                }
                // Paper 11: the calendar sits on the sheet, not in a card.
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.tight, bottom: 0, trailing: Tokens.Space.tight))
                Section {
                    timeRow
                    NavigationLink {
                        TaskWhenRepeatPage(
                            store: store,
                            taskId: task?.id,
                            anchorDate: draft.date,
                            original: RepeatChoice(rule: original.rule, repeatFrom: original.repeatFrom),
                            rule: $draft.rule,
                            repeatFrom: $draft.repeatFrom,
                            touched: $ruleTouched
                        )
                    } label: {
                        LabeledContent(TasksCopy.repeatTitle, value: repeatValue)
                    }
                    .accessibilityIdentifier("tasks.when.repeatRow")
                    NavigationLink {
                        TaskWhenReminderPage(store: store, task: task, reminder: $draft.reminder)
                    } label: {
                        LabeledContent(TasksCopy.whenRemindMe, value: reminderValue)
                    }
                    .accessibilityIdentifier("tasks.when.remindRow")
                    NavigationLink {
                        TaskWhenStartPage(store: store, startDate: $draft.startDate)
                    } label: {
                        LabeledContent(TasksCopy.fieldStartDate, value: startValue)
                    }
                    .accessibilityIdentifier("tasks.when.startRow")
                }
                .font(Tokens.Typography.body.font)
                .listRowBackground(Tokens.Canvas.surface.color)
                if draft.date != nil {
                    Section {
                        Button(TasksCopy.removeDate, role: .destructive) {
                            draft.date = nil
                            draft.time = nil
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.when.removeDate")
                    }
                    .listRowBackground(Tokens.Canvas.surface.color)
                }
            }
            .listSectionSpacing(.compact)
            .contentMargins(.top, Tokens.Space.tight, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .navigationTitle(TasksCopy.whenTitle)
            .navigationBarTitleDisplayMode(.inline)
            // Re-read on every return from the Remind me page, which writes.
            .onAppear {
                guard let id = task?.id else { return }
                Task { reminders = await store.activeReminders(of: id) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("tasks.when.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    TaskSheetConfirmButton(label: TasksCopy.dateDone, action: commit)
                        .accessibilityIdentifier("tasks.when.done")
                }
            }
        }
        // Paper 11: a tall detent over the detail, the calendar and rows in
        // view; drag up for the rest.
        .presentationDetents([.fraction(0.85), .large])
        // Paper 11 draws an opaque canvas sheet; the grouped rows stay legible
        // over the detail at the partial detent.
        .presentationBackground(Tokens.Canvas.background.color)
        .onDisappear {
            if let raised { store.prompt = raised }
        }
    }

    // MARK: Rows

    @ViewBuilder private var timeRow: some View {
        if draft.date != nil, let time = draft.time {
            HStack(spacing: Tokens.Space.small) {
                DatePicker(
                    TasksCopy.time,
                    selection: Binding(
                        get: { TaskTimeText.date(time) ?? store.clock() },
                        set: { draft.time = TaskTimeText.string($0) }
                    ),
                    displayedComponents: .hourAndMinute
                )
                .accessibilityIdentifier("tasks.when.time")
                Button {
                    draft.time = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.clearTime)
                .accessibilityIdentifier("tasks.when.clearTime")
            }
        } else {
            Button {
                if draft.date == nil { draft.date = store.today() }
                draft.time = TaskTimeText.defaultTime
            } label: {
                LabeledContent(TasksCopy.time, value: TasksCopy.addTime)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            .accessibilityIdentifier("tasks.when.addTime")
        }
    }

    private var repeatValue: String {
        if let rule = draft.rule { return TasksCopy.repeatSummary(rule) }
        if !ruleTouched, store.isRepeating(task?.id) { return TasksCopy.repeats }
        return TasksCopy.whenNever
    }

    private var reminderValue: String {
        if task != nil {
            guard let first = reminders.first else { return TasksCopy.whenNone }
            if reminders.count > 1 { return TasksCopy.whenReminderCount(reminders.count) }
            return TaskReminderPresets.instant(first.remindAt)
                .map { TaskReminderPresets.text($0, now: store.clock()) } ?? first.remindAt
        }
        return draft.reminder.map { TaskReminderPresets.text($0, now: store.clock()) } ?? TasksCopy.whenNone
    }

    private var startValue: String {
        guard let start = draft.startDate else { return TasksCopy.whenNone }
        return TaskDueLabel.make(date: start, time: nil, today: store.today(), isDone: false)?.text ?? start
    }

    /// The user's `weekStartDay` (0 Sunday, 1 Monday) as the first column.
    private var weekCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = Int(store.weekStartsOn) + 1
        return calendar
    }

    // MARK: Actions

    private func apply(_ reading: TaskWhenReading) {
        if let date = reading.date {
            draft.date = date
            draft.time = reading.time ?? draft.time
        } else if let time = reading.time {
            if draft.date == nil { draft.date = store.today() }
            draft.time = time
        }
        if let rule = reading.rule {
            draft.rule = rule
            ruleTouched = true
        }
    }

    private func commit() {
        guard let task else {
            onCommit(draft, original)
            dismiss()
            return
        }
        raised = TaskWhenCommit.write(
            store: store, task: task, original: original, draft: draft, ruleTouched: ruleTouched
        )
        dismiss()
    }
}

/// How the When sheet writes a task, and which question it leaves behind.
enum TaskWhenCommit {
    /// Writes what can be written now; returns the prompt to raise once the
    /// sheet has gone (Edit / Stop Repeating), if any.
    @MainActor
    static func write(
        store: TasksStore, task: TaskItem, original: TaskWhenDraft, draft: TaskWhenDraft, ruleTouched: Bool
    ) -> TasksPrompt? {
        let dueChanged = draft.date != original.date || draft.time != original.time
        let startChanged = draft.startDate != original.startDate
        let outcome = RepeatSheetOutcome.resolve(
            taskId: task.id,
            wasRepeating: store.isRepeating(task.id),
            original: RepeatChoice(rule: original.rule, repeatFrom: original.repeatFrom),
            draft: RepeatChoice(rule: draft.rule, repeatFrom: draft.repeatFrom),
            touched: ruleTouched
        )
        let dueEdit = RepeatingEdit.due(date: draft.date, time: draft.date == nil ? nil : draft.time)
        let startEdit = RepeatingEdit.start(date: draft.startDate)
        // On a series, one Edit Repeating question covers every change made
        // together (date, start, rule); "only this" or "all" applies them all.
        var seriesEdits: [RepeatingEdit] = []
        if store.isRepeating(task.id), outcome.isStop == false {
            if dueChanged { seriesEdits.append(dueEdit) }
            if startChanged { seriesEdits.append(startEdit) }
            if case let .editRepeating(_, edit) = outcome { seriesEdits.append(edit) }
        }
        if !seriesEdits.isEmpty {
            store.stashRepeatingEdits(taskId: task.id, seriesEdits)
            return .editRepeating(taskId: task.id)
        }
        // Not a series (or the series ends): dates write now.
        Task {
            if dueChanged {
                await store.detailSetDue(task, date: draft.date, time: draft.date == nil ? nil : draft.time)
            }
            if startChanged { await store.detailSetStartDate(task, date: draft.startDate) }
            if case let .commit(rule, from) = outcome {
                await store.detailSetRepeat(task, rule: rule, repeatFrom: from)
            }
        }
        switch outcome {
        case let .stopRepeating(id):
            return .stopRepeating(taskId: id)
        case let .editRepeating(id, edit):
            store.stashRepeatingEdit(taskId: id, edit)
            return .editRepeating(taskId: id)
        case .unchanged, .commit:
            return nil
        }
    }
}

private extension RepeatSheetOutcome {
    var isStop: Bool {
        if case .stopRepeating = self { return true }
        return false
    }
}

extension TasksCopy {
    static let whenNone = "None"
    static let whenManage = "Manage"
}
