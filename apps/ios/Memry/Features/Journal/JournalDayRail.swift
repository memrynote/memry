import MemryCore
import SwiftUI

// #4351 (D8, D9). The Journal rail at regular width (DESIGN.md › Tablet ›
// Side rails): a mini month calendar that jumps to a day and marks the days
// with an entry, the day's tasks and events, and the same day in other
// years. No statistics, no AI connections. The day screen lays it beside
// the pager in its own `Tokens.Size.rail` of width, so the entry never
// slides under it.

extension EnvironmentValues {
    /// The day screen shows the rail, which carries the day's tasks; the
    /// Day section under the entry then stays out of the way.
    @Entry var journalRailShown = false
}

struct JournalDayRail: View {
    let store: JournalStore
    let date: String
    /// Shows a day in place, as ‹ › do.
    let show: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                JournalMiniMonth(store: store, date: date, show: show)
                JournalDayAgenda(date: date, today: store.clock.today)
                JournalOnThisDay(store: store, date: date, show: show)
            }
            .padding(Tokens.Space.medium)
        }
        .frame(width: Tokens.Size.rail)
        .background(Tokens.Canvas.background.color)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(width: Tokens.Size.hairline)
                .ignoresSafeArea()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(JournalCopy.Rail.label)
        .accessibilityIdentifier("journal.rail")
    }
}

/// The month around the shown day. ‹ › page the months without moving the
/// day; a tap on a day shows it.
private struct JournalMiniMonth: View {
    let store: JournalStore
    let date: String
    let show: (String) -> Void

    @Environment(\.calendarStore) private var calendar
    /// The first of the month on show, or `nil` to follow `date`.
    @State private var paged: String?

    private var first: String { paged ?? String(date.prefix(7)) + "-01" }
    private var weekStartsOn: Int { calendar?.weekStartsOn ?? 1 }

    var body: some View {
        let (year, month) = JournalDates.yearMonth(first)
        let marked = Set(store.month(year: year, month: month)?.days.filter(\.hasEntry).map(\.date) ?? [])
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            header(year: year, month: month)
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(0 ..< 7, id: \.self) { column in
                        Text(JournalCopy.weekdayShort(column + weekStartsOn).prefix(2))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                            .frame(maxWidth: .infinity)
                            .accessibilityHidden(true)
                    }
                }
                let days = CalendarDates.monthGrid(first, weekStartsOn: weekStartsOn)
                ForEach(0 ..< days.count / 7, id: \.self) { week in
                    GridRow {
                        ForEach(days[week * 7 ..< week * 7 + 7], id: \.self) { day in
                            cell(day, inMonth: day.hasPrefix(String(first.prefix(7))), marked: marked.contains(day))
                        }
                    }
                }
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        .onChange(of: date) { paged = nil }
        // A write or a sync pass re-reads a loaded month in the store.
        .task(id: first) { await store.loadMonth(year: year, month: month) }
        .accessibilityIdentifier("journal.rail.month")
    }

    private func header(year: Int, month: Int) -> some View {
        HStack(spacing: 0) {
            Text(JournalCopy.monthAndYear(year: year, month: month))
                .font(Tokens.Typography.label.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Tokens.Space.small)
            step(-1, label: JournalCopy.Rail.previousMonth, symbol: "chevron.backward", id: "previous")
            step(1, label: JournalCopy.Rail.nextMonth, symbol: "chevron.forward", id: "next")
        }
    }

    private func step(_ offset: Int, label: String, symbol: String, id: String) -> some View {
        Button(label, systemImage: symbol) {
            let (year, month) = JournalDates.yearMonth(first)
            let moved = JournalMonthStep.shifted(year: year, month: month, by: offset)
            paged = JournalDates.firstOfMonth(year: moved.year, month: moved.month)
        }
        .labelStyle(.iconOnly)
        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityIdentifier("journal.rail.month.\(id)")
    }

    private func cell(_ day: String, inMonth: Bool, marked: Bool) -> some View {
        let isShown = day == date
        let isToday = day == store.clock.today
        return Button { show(day) } label: {
            VStack(spacing: 2) {
                Text(verbatim: "\(JournalDates.day(day))")
                    .font(Tokens.Typography.supporting.font.monospacedDigit().weight(isShown || isToday ? .semibold : .regular))
                    .foregroundStyle(numberColor(isShown: isShown, isToday: isToday, inMonth: inMonth))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .frame(width: Tokens.Calendar.dayCircle, height: Tokens.Calendar.dayCircle)
                    .background {
                        // The Calendar week strip's marks: today in the tint,
                        // the selected day on the active surface.
                        if isToday {
                            Circle().fill(Tokens.Tint.base.color)
                        } else if isShown {
                            Circle().fill(Tokens.Canvas.surfaceActive.color)
                        }
                    }
                Circle()
                    .fill(marked ? Tokens.Journal.activity(2).color : .clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(JournalCopy.Rail.dayCell(day, hasEntry: marked))
        .accessibilityAddTraits(isShown ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(isToday ? JournalCopy.today : "")
        .accessibilityIdentifier("journal.rail.day.\(day)")
    }

    private func numberColor(isShown: Bool, isToday: Bool, inMonth: Bool) -> Color {
        if isToday { return Tokens.Tint.foreground.color }
        if isShown { return Tokens.Text.primary.color }
        return inMonth ? Tokens.Text.primary.color : Tokens.Text.tertiary.color
    }
}
