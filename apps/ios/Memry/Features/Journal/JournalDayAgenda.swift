import MemryCore
import SwiftUI

// #4351 (D8). The day's tasks and events, the Journal rail's middle part
// (desktop `journal-day-panel.tsx`: the day schedule, then the tasks due on
// the day with today's overdue count). It takes only a date and reads the
// vault's tasks and calendar stores from the environment, so the Day Panel
// rail (#4380) can show the same view for any day.
//
// Tasks keep their one owner, the Day section's `JournalDueTasks`. The
// schedule lists the calendar's events and reminders; task projections stay
// out of it, since the task list below already shows them. A tap opens the
// item in Calendar through `CalendarLinks`, as a project hub's event does.

struct JournalDayAgenda: View {
    let date: String
    let today: String

    @Environment(\.journalTasks) private var tasks
    @Environment(\.calendarStore) private var calendar

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.section) {
            if let calendar {
                JournalDaySchedule(calendar: calendar, date: date)
            }
            if let tasks {
                JournalDueTasks(tasks: tasks, date: date, today: today)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The calendar items of one day, all-day ones first, then by start.
enum JournalDayScheduleItems {
    static func on(_ day: String, in items: [CalendarItem]) -> [CalendarItem] {
        items
            .filter { $0.visualType != "task" && CalendarDates.covers($0, day) }
            .sorted { lhs, rhs in
                lhs.isSpanning != rhs.isSpanning ? lhs.isSpanning : lhs.startDate < rhs.startDate
            }
    }
}

private struct JournalDaySchedule: View {
    let calendar: CalendarStore
    let date: String

    private var window: CalendarWindow {
        CalendarPeriods.window(.day, anchor: date, weekStartsOn: calendar.weekStartsOn, zoom: .months)
    }

    var body: some View {
        let items = JournalDayScheduleItems.on(date, in: calendar.items(in: window))
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(JournalCopy.Rail.schedule)
                .font(Tokens.Typography.label.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            if items.isEmpty {
                Text(JournalCopy.Rail.noSchedule)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            } else {
                ForEach(items, id: \.projectionId) { item in
                    row(item)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("journal.rail.schedule")
        .task(id: window) {
            // The Calendar page loads the store when it first shows; a
            // journal opened first reads it here.
            if !calendar.hasLoaded { await calendar.load() }
            await calendar.ensure(window)
        }
    }

    private func row(_ item: CalendarItem) -> some View {
        let hue = CalendarItemStyle.hue(item)
        return Button {
            CalendarLinks.shared.request(CalendarLink(date: date, event: item.projectionId))
        } label: {
            HStack(alignment: .top, spacing: Tokens.Space.small) {
                Capsule()
                    .fill(hue.rail.color)
                    .frame(width: Tokens.Calendar.railWidth)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Tokens.Space.tight / 2) {
                    Text(item.title)
                        .font(Tokens.Typography.supporting.font.weight(.medium))
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(2)
                    Text(item.isSpanning ? JournalCopy.Rail.allDay : CalendarItemStyle.timeRange(item))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(hue.meta.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, Tokens.Space.tight)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CalendarItemStyle.accessibilityLabel(item))
        .accessibilityHint(JournalCopy.Rail.openEvent)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("journal.rail.event.\(item.projectionId)")
    }
}
