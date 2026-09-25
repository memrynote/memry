import MemryCore
import SwiftUI

// TP044. The date and time picker every task surface opens: due date (with a
// time) and start date (without). After desktop's `due-date-picker.tsx` and
// `date-picker-content.tsx`:
//
// - a natural-language field whose date the core resolves as you type;
// - Today / Tomorrow / This Weekend / Next Week, dates from the core;
// - a graphical calendar with a "Today" jump, then Done;
// - add or clear a time (9:00 AM when added, as desktop);
// - remove the date.
//
// A suggestion or a typed date commits at once and closes, as desktop's
// popover does; the calendar and the time are a draft that Done commits.

/// TP044 — date and time picker.
struct TaskDateSheet: View {
    let title: String
    let date: String?
    let time: String?
    let allowsTime: Bool
    let store: TasksStore
    let onCommit: (String?, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draftDate: String?
    @State private var draftTime: String?

    init(
        title: String,
        date: String?,
        time: String?,
        allowsTime: Bool,
        store: TasksStore,
        onCommit: @escaping (String?, String?) -> Void
    ) {
        self.title = title
        self.date = date
        self.time = time
        self.allowsTime = allowsTime
        self.store = store
        self.onCommit = onCommit
        let day = date.map { String($0.prefix(10)) }
        _draftDate = State(initialValue: day)
        _draftTime = State(initialValue: allowsTime && day != nil ? time : nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(TasksCopy.longDate(draftDate, time: allowsTime ? draftTime : nil))
                        .font(Tokens.Typography.label.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityIdentifier("tasks.date.current")
                    TaskDateNaturalField(store: store) { parsed in
                        commit(parsed.date, parsed.time ?? draftTime)
                    }
                }
                Section(TasksCopy.dateSuggestions) {
                    ForEach(store.dateSuggestions()) { suggestion in
                        TaskDateSuggestionRow(suggestion: suggestion, isSelected: draftDate == suggestion.date) {
                            commit(suggestion.date, draftTime)
                        }
                    }
                }
                Section(TasksCopy.pickADate) { calendar }
                if allowsTime, draftDate != nil {
                    Section(TasksCopy.time) { timeRow }
                }
                if date != nil || draftDate != nil {
                    Section {
                        Button(TasksCopy.removeDate, role: .destructive) { commit(nil, nil) }
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                            .accessibilityIdentifier("tasks.date.remove")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("tasks.date.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: TasksCopy.dateDone) { commit(draftDate, draftTime) }
                        .accessibilityIdentifier("tasks.date.done")
                }
            }
        }
    }

    // MARK: Calendar

    private var calendar: some View {
        VStack(alignment: .trailing, spacing: Tokens.Space.small) {
            DatePicker(
                TasksCopy.pickADate,
                selection: Binding(
                    get: { draftDate.flatMap(TaskDates.date) ?? store.clock() },
                    set: { draftDate = TaskDates.key($0) }
                ),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .labelsHidden()
            .tint(Tokens.Text.tint.color)
            .environment(\.calendar, weekCalendar)
            .accessibilityIdentifier("tasks.date.calendar")
            Button(TasksCopy.calendarToday) { draftDate = store.today() }
                .buttonStyle(.borderless)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityHint(TasksCopy.calendarTodayHint)
                .accessibilityIdentifier("tasks.date.calendarToday")
        }
    }

    /// The user's `weekStartDay` (0 Sunday, 1 Monday) as the calendar's first column.
    private var weekCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = Int(store.weekStartsOn) + 1
        return calendar
    }

    // MARK: Time

    @ViewBuilder
    private var timeRow: some View {
        if let draftTime {
            DatePicker(
                TasksCopy.time,
                selection: Binding(
                    get: { TaskTimeText.date(draftTime) ?? store.clock() },
                    set: { self.draftTime = TaskTimeText.string($0) }
                ),
                displayedComponents: .hourAndMinute
            )
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.date.time")
            Button(TasksCopy.clearTime, role: .destructive) { self.draftTime = nil }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.date.clearTime")
        } else {
            Button {
                self.draftTime = TaskTimeText.defaultTime
            } label: {
                Label(TasksCopy.addTime, systemImage: "clock")
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.date.addTime")
        }
    }

    // MARK: Commit

    /// A time only rides with a date, and only where the field takes one.
    private func commit(_ date: String?, _ time: String?) {
        onCommit(date, date != nil && allowsTime ? time : nil)
        dismiss()
    }
}
