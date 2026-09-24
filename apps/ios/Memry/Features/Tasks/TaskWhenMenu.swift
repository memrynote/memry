import MemryCore
import SwiftUI

// RD05. The When menu (Paper artboard 05): one tap for the usual dates. A
// medium icon row (Today, Tomorrow, Next week), This weekend with its day,
// Pick date & time… (the When sheet), Repeat › (desktop's presets, anchored
// on the date), Remind me › (desktop's reminder presets) and Remove date.
//
// The same content serves the composer's date chip, the detail's When pill
// and a row's swipe Date action, so each caller hands it closures over its
// own target (a draft, or a task). Dates are the core parser's answers: the
// icon row uses the Move menu's targets (desktop: today, +1, +7 days).

/// What the When menu edits and how.
struct TaskWhenActions {
    var date: String?
    var rule: RepeatRule?
    var reminderCount: Int = 0
    /// A day, keeping the time.
    let setDate: (String) -> Void
    let removeDate: () -> Void
    /// Opens the When sheet (date, time, custom repeat, reminders, start).
    let pickDateTime: () -> Void
    /// A preset rule, or `nil` for "Never". `nil` hides the Repeat submenu.
    var setRule: ((RepeatRule?) -> Void)?
    /// A preset reminder time. `nil` hides the Remind me submenu.
    var addReminder: ((Date) -> Void)?
}

/// The When menu's content.
struct TaskWhenMenu: View {
    let store: TasksStore
    let actions: TaskWhenActions

    var body: some View {
        ControlGroup {
            ForEach([TaskRescheduleOption.today, .tomorrow, .nextWeek]) { option in
                Button {
                    if let date = store.rowRescheduleDate(option) { actions.setDate(date) }
                } label: {
                    Label(option.title, systemImage: option.symbol)
                }
                .accessibilityIdentifier("tasks.when.\(option.rawValue)")
            }
        }
        .controlGroupStyle(.menu)

        if let weekend = store.dateSuggestions().first(where: { $0.kind == .weekend }) {
            Button {
                actions.setDate(weekend.date)
            } label: {
                Text(TasksCopy.whenThisWeekend)
                Text(TasksCopy.shortWeekday(weekend.date))
            }
            .accessibilityIdentifier("tasks.when.weekend")
        }
        Button(TasksCopy.whenPickDateTime, systemImage: "calendar", action: actions.pickDateTime)
            .accessibilityIdentifier("tasks.when.pick")

        Section {
            if let setRule = actions.setRule {
                Menu {
                    Button(TasksCopy.whenNever) { setRule(nil) }
                    ForEach(store.repeatPresets(anchorDate: actions.date)) { preset in
                        Button(TasksCopy.repeatPresetLabel(preset)) { setRule(preset.rule) }
                    }
                    Button(TasksCopy.customRepeatRow, action: actions.pickDateTime)
                } label: {
                    Text(TasksCopy.repeatTitle)
                    Text(actions.rule.map(TasksCopy.repeatSummary) ?? TasksCopy.whenNever)
                }
                .accessibilityIdentifier("tasks.when.repeat")
            }
            if let addReminder = actions.addReminder {
                Menu {
                    ForEach(TaskReminderPresets.standard(now: store.clock())) { preset in
                        Button {
                            addReminder(preset.date)
                        } label: {
                            Text(preset.label)
                            if let detail = preset.detail { Text(detail) }
                        }
                    }
                    Button(TasksCopy.reminderCustom, action: actions.pickDateTime)
                } label: {
                    Text(TasksCopy.whenRemindMe)
                    Text(TasksCopy.whenReminderCount(actions.reminderCount))
                }
                .accessibilityIdentifier("tasks.when.remind")
            }
        }

        if actions.date != nil {
            Section {
                Button(TasksCopy.removeDate, role: .destructive, action: actions.removeDate)
                    .accessibilityIdentifier("tasks.when.remove")
            }
        }
    }
}

extension TasksCopy {
    static let whenTitle = "When"
    static let whenThisWeekend = "This weekend"
    static let whenPickDateTime = "Pick date & time…"
    static let whenNever = "Never"
    static let whenRemindMe = "Remind me"
    static let reminderCustom = "Custom…"

    static func whenReminderCount(_ count: Int) -> String {
        switch count {
        case 0: "None"
        case 1: "1 set"
        default: "\(count) set"
        }
    }

    /// `2026-09-26` as "Sat".
    static func shortWeekday(_ key: String) -> String {
        TaskDates.date(key)?.formatted(.dateTime.weekday(.abbreviated)) ?? key
    }
}
