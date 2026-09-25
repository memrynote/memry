import SwiftUI

// IB09. The snooze presets, computed on the device as desktop's renderer does
// (`components/snooze/snooze-presets.ts`), and the menu that offers them
// (Paper 09): Later today, Tomorrow, This weekend, Next week, In 1 hour,
// In 2 hours, each with its resolved time, then Pick date & time….

enum InboxSnoozePreset: String, CaseIterable, Identifiable {
    case laterToday, tomorrow, thisWeekend, nextWeek, inOneHour, inTwoHours

    var id: String { rawValue }

    var label: String {
        switch self {
        case .laterToday: "Later today"
        case .tomorrow: "Tomorrow"
        case .thisWeekend: "This weekend"
        case .nextWeek: "Next week"
        case .inOneHour: "In 1 hour"
        case .inTwoHours: "In 2 hours"
        }
    }

    var symbol: String {
        switch self {
        case .laterToday: "sun.max"
        case .tomorrow: "sunrise"
        case .thisWeekend: "sofa"
        case .nextWeek: "calendar"
        case .inOneHour, .inTwoHours: "clock"
        }
    }

    /// The instant this preset resolves to at `now`.
    func date(now: Date, calendar: Calendar = .current) -> Date {
        switch self {
        case .laterToday:
            // 3 hours from now or 18:00, whichever is later; after 18:00, 09:00 tomorrow.
            if calendar.component(.hour, from: now) >= 18 {
                return Self.next(hour: 9, after: now, calendar: calendar)
            }
            let threeHours = now.addingTimeInterval(3 * 3600)
            let sixPm = Self.at(hour: 18, on: now, calendar: calendar)
            return max(threeHours, sixPm)
        case .tomorrow:
            let day = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
            return Self.at(hour: 9, on: day, calendar: calendar)
        case .thisWeekend:
            return Self.nextWeekday(7, hour: 9, from: now, calendar: calendar)
        case .nextWeek:
            return Self.nextWeekday(2, hour: 9, from: now, calendar: calendar)
        case .inOneHour:
            return now.addingTimeInterval(3600)
        case .inTwoHours:
            return now.addingTimeInterval(7200)
        }
    }

    private static func at(hour: Int, on day: Date, calendar: Calendar) -> Date {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
    }

    /// `getNextOccurrence`: today at `hour` if still ahead, else tomorrow.
    private static func next(hour: Int, after now: Date, calendar: Calendar) -> Date {
        let today = at(hour: hour, on: now, calendar: calendar)
        if today > now { return today }
        return calendar.date(byAdding: .day, value: 1, to: today) ?? today
    }

    /// `getNextSaturday` / `getNextMonday`: `weekday` (1 = Sunday) at `hour`;
    /// on that weekday itself, today while the hour is ahead, else a week on.
    private static func nextWeekday(_ weekday: Int, hour: Int, from now: Date, calendar: Calendar) -> Date {
        let current = calendar.component(.weekday, from: now)
        if current == weekday {
            let today = at(hour: hour, on: now, calendar: calendar)
            if now < today { return today }
            return calendar.date(byAdding: .day, value: 7, to: today) ?? today
        }
        let ahead = (weekday - current + 7) % 7
        let day = calendar.date(byAdding: .day, value: ahead, to: calendar.startOfDay(for: now)) ?? now
        return at(hour: hour, on: day, calendar: calendar)
    }

    /// The trailing time (Paper 09): "18:00", "Fri 09:00".
    func detail(now: Date, calendar: Calendar = .current) -> String {
        let target = date(now: now, calendar: calendar)
        let time = target.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDate(target, inSameDayAs: now) { return time }
        return "\(target.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }
}

enum InboxSnoozeFormat {
    /// `formatSnoozeTime`: "Today at 18:00", "Tomorrow at 09:00", "Monday at
    /// 09:00", "Oct 3, 09:00".
    static func until(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)
        ).day ?? 0
        switch days {
        case 0: return "Today at \(time)"
        case 1: return "Tomorrow at \(time)"
        case 2 ..< 7: return "\(date.formatted(.dateTime.weekday(.wide))) at \(time)"
        default: return "\(date.formatted(.dateTime.month(.abbreviated).day())), \(time)"
        }
    }
}

/// The snooze menu's items (Paper 09), for a row, the detail or a selection.
struct InboxSnoozeMenuItems: View {
    let now: Date
    let snooze: (Date) -> Void
    let pickDate: () -> Void

    var body: some View {
        Section(InboxCopy.snoozeUntil) {
            ForEach(InboxSnoozePreset.allCases) { preset in
                Button {
                    snooze(preset.date(now: now))
                } label: {
                    Label {
                        Text(preset.label)
                        Text(preset.detail(now: now))
                    } icon: {
                        Image(systemName: preset.symbol)
                    }
                }
                .accessibilityIdentifier("inbox.snooze.\(preset.rawValue)")
            }
        }
        Button(InboxCopy.pickDateTime, systemImage: "calendar.badge.clock", action: pickDate)
            .accessibilityIdentifier("inbox.snooze.pick")
    }
}

/// Pick date & time (00 audit: the system date picker in a sheet).
struct InboxSnoozeDateSheet: View {
    let now: Date
    let commit: (Date) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date

    init(now: Date, commit: @escaping (Date) -> Void) {
        self.now = now
        self.commit = commit
        _date = State(initialValue: InboxSnoozePreset.tomorrow.date(now: now))
    }

    var body: some View {
        NavigationStack {
            DatePicker(InboxCopy.snoozeUntil, selection: $date, in: now..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.graphical)
                .padding(.horizontal, Tokens.Space.inset)
                .navigationTitle(InboxCopy.snooze)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(InboxCopy.close, systemImage: "xmark") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        SheetConfirmButton(label: InboxCopy.snooze, isEnabled: date > now) {
                            commit(date)
                            dismiss()
                        }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}
