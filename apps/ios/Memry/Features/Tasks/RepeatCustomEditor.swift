import MemryCore
import SwiftUI

// TP045. The custom rule (`custom-repeat-dialog.tsx`): every N days / weeks /
// months / years, the weekdays of a weekly rule, a monthly rule by day or by
// "the Nth weekday" (5 = last), how the series ends, and a live preview of
// the next dates from the core (`repeatPreview`).

struct RepeatCustomEditor: View {
    let anchorDate: String?
    let store: TasksStore
    let onSave: (RepeatRule) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: RepeatDraft

    init(initial: RepeatRule?, anchorDate: String?, store: TasksStore, onSave: @escaping (RepeatRule) -> Void) {
        self.anchorDate = anchorDate
        self.store = store
        self.onSave = onSave
        _draft = State(initialValue: RepeatDraft(rule: initial, anchor: store.repeatAnchor(anchorDate)))
    }

    var body: some View {
        Form {
            Section(TasksCopy.repeatFrequency) { frequency }
            if draft.frequency == "weekly" {
                Section(TasksCopy.repeatOnTheseDays) { weekdays }
            }
            if draft.frequency == "monthly" {
                Section(TasksCopy.repeatOn) { RepeatMonthlyOptions(draft: $draft) }
            }
            Section(TasksCopy.repeatEnds) { RepeatEndOptions(draft: $draft, anchor: startKey, store: store) }
            Section(TasksCopy.repeatPreview) { preview }
        }
        .font(Tokens.Typography.body.font)
        .navigationTitle(TasksCopy.customRepeatTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                TaskSheetConfirmButton(label: TasksCopy.repeatSave) {
                    onSave(draft.rule)
                    dismiss()
                }
                .accessibilityIdentifier("tasks.repeat.customSave")
            }
        }
    }

    private var startKey: String { String((anchorDate ?? store.today()).prefix(10)) }

    // MARK: Frequency

    private var frequency: some View {
        Group {
            Stepper(value: $draft.interval, in: 1 ... 99) {
                Text("\(TasksCopy.repeatEvery) \(draft.interval)")
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityValue("\(draft.interval) \(TasksCopy.repeatUnit(draft.frequency, interval: draft.interval))")
            .accessibilityIdentifier("tasks.repeat.interval")
            Picker(TasksCopy.repeatFrequency, selection: $draft.frequency) {
                ForEach(["daily", "weekly", "monthly", "yearly"], id: \.self) { value in
                    Text(TasksCopy.repeatUnit(value, interval: draft.interval)).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.frequency")
        }
    }

    // MARK: Weekdays

    private var weekdays: some View {
        HStack(spacing: Tokens.Space.tight) {
            ForEach(0 ..< 7, id: \.self) { day in
                let selected = draft.daysOfWeek.contains(Int64(day))
                Button {
                    draft.toggle(day: Int64(day))
                } label: {
                    Text(String(TasksCopy.shortDayNames[day].prefix(1)))
                        .font(Tokens.Typography.label.font)
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                        .foregroundStyle(
                            selected ? Tokens.Interaction.actionForeground.color : Tokens.Text.secondary.color
                        )
                        .background(
                            selected ? Tokens.Interaction.actionFill.color : Tokens.Canvas.surface.color,
                            in: .circle
                        )
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(TasksCopy.repeatWeekdayToggle(day, selected: selected))
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
                .accessibilityIdentifier("tasks.repeat.day.\(day)")
            }
        }
    }

    // MARK: Preview

    private var preview: some View {
        let rule = draft.rule
        let dates = store.repeatPreviewDates(rule, anchorDate: startKey)
        return VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(TasksCopy.repeatPreviewHeader(rule))
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            ForEach(Array(dates.enumerated()), id: \.offset) { index, key in
                HStack(spacing: Tokens.Space.small) {
                    Text(TasksCopy.previewDate(key))
                        .foregroundStyle(Tokens.Text.primary.color)
                    if rule.endType == "count", let total = rule.endCount {
                        Text(TasksCopy.repeatPreviewIndex(index + 1, of: total))
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                }
                .font(Tokens.Typography.supporting.font)
            }
            if dates.count >= 5, rule.endType == "never" {
                Text(TasksCopy.repeatAndMore)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.repeat.preview")
    }
}

/// Monthly by day of the month, or by "the Nth weekday" (5 = last).
private struct RepeatMonthlyOptions: View {
    @Binding var draft: RepeatDraft

    var body: some View {
        Picker(TasksCopy.repeatOn, selection: $draft.monthlyType) {
            Text(TasksCopy.repeatMonthDay).tag("dayOfMonth")
            Text(TasksCopy.repeatMonthThe).tag("weekPattern")
        }
        .pickerStyle(.segmented)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("tasks.repeat.monthlyType")
        if draft.monthlyType == "dayOfMonth" {
            Picker("\(TasksCopy.repeatMonthDay) (\(TasksCopy.repeatOfTheMonth))", selection: $draft.dayOfMonth) {
                ForEach(Int64(1) ... 31, id: \.self) { day in Text("\(day)").tag(day) }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.dayOfMonth")
        } else {
            Picker(TasksCopy.repeatMonthThe, selection: $draft.weekOfMonth) {
                ForEach(Int64(1) ... 5, id: \.self) { week in Text(TasksCopy.ordinal(week)).tag(week) }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.weekOfMonth")
            Picker(TasksCopy.repeatOfTheMonth, selection: $draft.dayOfWeekForMonth) {
                ForEach(Int64(0) ... 6, id: \.self) { day in Text(TasksCopy.dayName(day)).tag(day) }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.weekdayOfMonth")
        }
    }
}

/// Never, on a date (not before today, as desktop), or after N occurrences.
private struct RepeatEndOptions: View {
    @Binding var draft: RepeatDraft
    /// Where the end date starts when "On date" is first picked.
    let anchor: String
    let store: TasksStore

    var body: some View {
        Picker(TasksCopy.repeatEnds, selection: Binding(
            get: { draft.endType },
            set: { value in
                draft.endType = value
                if value == "date", draft.endDate == nil { draft.endDate = anchor }
            }
        )) {
            Text(TasksCopy.repeatEndsNever).tag("never")
            Text(TasksCopy.repeatEndsOnDate).tag("date")
            Text(TasksCopy.repeatEndsAfter).tag("count")
        }
        .pickerStyle(.segmented)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityIdentifier("tasks.repeat.endType")
        if draft.endType == "date" {
            DatePicker(
                TasksCopy.repeatEndsOnDate,
                selection: Binding(
                    get: { draft.endDate.flatMap(TaskDates.date) ?? store.clock() },
                    set: { draft.endDate = TaskDates.key($0) }
                ),
                in: Calendar(identifier: .gregorian).startOfDay(for: store.clock())...,
                displayedComponents: .date
            )
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.endDate")
        } else if draft.endType == "count" {
            Stepper(value: $draft.endCount, in: 1 ... 999) {
                Text("\(TasksCopy.repeatEndsAfter) \(draft.endCount) \(TasksCopy.repeatOccurrences)")
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.repeat.endCount")
        }
    }
}
