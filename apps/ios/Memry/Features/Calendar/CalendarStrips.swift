import MemryCore
import SwiftUI

// Spec 007 CL021/CL030 (artboard 01). The week strip over Day (weekday letter,
// day number, the type dots of the day; today a tint circle with an ink
// number) and the all-day strip (spans with "Day 2 of 3", dashed date
// reminders).

struct CalendarWeekStrip: View {
    let days: [String]
    let selected: String
    let today: String
    let items: [CalendarItem]
    let select: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
                Button { select(day) } label: { cell(day) }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityLabel(Self.accessibleDay(day))
                    .accessibilityAddTraits(day == selected ? .isSelected : [])
                    .accessibilityIdentifier("calendar.strip.\(day)")
            }
        }
        .padding(.horizontal, Tokens.Space.medium)
        .padding(.bottom, Tokens.Space.small)
    }

    private func cell(_ day: String) -> some View {
        let isToday = day == today
        let isSelected = day == selected
        let weekend = CalendarDates.isWeekend(day)
        let dim = weekend && !isToday && !isSelected
        return VStack(spacing: Tokens.Space.tight) {
            Text(CalendarDates.start(of: day).formatted(.dateTime.weekday(.narrow)))
                .font(Tokens.Calendar.weekdayLetter.font)
                .foregroundStyle(isToday ? Tokens.Text.tint.color : Tokens.Text.tertiary.color)
            Text(CalendarDates.start(of: day).formatted(.dateTime.day()))
                .font(Tokens.Typography.body.font.weight(isToday || isSelected ? .semibold : .regular))
                .foregroundStyle(numberColor(isToday: isToday, isSelected: isSelected, dim: dim))
                .frame(width: Tokens.Calendar.dayCircle, height: Tokens.Calendar.dayCircle)
                .background {
                    if isToday {
                        Circle().fill(Tokens.Tint.base.color)
                    } else if isSelected {
                        Circle().fill(Tokens.Canvas.surfaceActive.color)
                    }
                }
            CalendarDayDots(items: items.filter { CalendarDates.covers($0, day) }, isToday: isToday)
        }
        .contentShape(.rect)
    }

    private func numberColor(isToday: Bool, isSelected: Bool, dim: Bool) -> Color {
        if isToday { return Tokens.Tint.foreground.color }
        if dim { return Tokens.Text.tertiary.color }
        return Tokens.Text.primary.color
    }

    static func accessibleDay(_ day: String) -> String {
        CalendarDates.start(of: day).formatted(.dateTime.weekday(.wide).month(.wide).day())
    }
}

/// Up to three type dots (desktop `day-dots.ts`: distinct hues in type order).
struct CalendarDayDots: View {
    let items: [CalendarItem]
    var isToday = false
    var limit = 3

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(hues.prefix(limit).enumerated()), id: \.offset) { _, hue in
                Circle()
                    .fill(isToday ? Tokens.Text.tint.color : hue.rail.color)
                    .frame(width: Tokens.Calendar.dot, height: Tokens.Calendar.dot)
            }
        }
        .frame(height: Tokens.Calendar.dot)
        .accessibilityHidden(true)
    }

    private var hues: [Tokens.Calendar.Hue] {
        var seen: [Tokens.Calendar.Hue] = []
        let order = CalendarVisualType.allCases.map(\.rawValue)
        for item in items.sorted(by: { (order.firstIndex(of: $0.visualType) ?? 9) < (order.firstIndex(of: $1.visualType) ?? 9) }) {
            let hue = CalendarItemStyle.hue(item)
            if !seen.contains(hue) { seen.append(hue) }
        }
        return seen
    }
}

/// All-day and multi-day items for one day (Day) with "Day n of m".
struct CalendarAllDayStrip: View {
    let day: String
    let items: [CalendarItem]
    let now: Date
    let actions: CalendarGridActions

    var body: some View {
        let spans = items.filter { $0.isSpanning && CalendarDates.covers($0, day) }
        if !spans.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                Text(CalendarCopy.allDayLower)
                    .font(Tokens.Calendar.gutter.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(width: Tokens.Calendar.gutterWidth - Tokens.Space.small, alignment: .trailing)
                    .padding(.trailing, Tokens.Space.small)
                    .padding(.top, 3)
                // Up to three rows show; more scroll inside the strip (§6 CL031).
                ScrollView(.vertical) {
                VStack(spacing: 3) {
                    ForEach(spans, id: \.projectionId) { item in
                        CalendarChip(
                            item: item, now: now,
                            onComplete: item.visualType == "task" ? { actions.complete(item) } : nil,
                            spanLabel: label(item),
                            showsTime: CalendarDates.spanStart(item) == day
                        )
                        .frame(height: 24)
                        .onTapGesture { actions.open(item) }
                        .calendarItemMenu(actions.contextMenu, item: item)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(CalendarItemStyle.accessibilityLabel(item))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { actions.open(item) }
                    }
                }
                }
                .frame(maxHeight: spans.count > 3 ? 3 * 27 + 12 : nil)
                .fixedSize(horizontal: false, vertical: spans.count <= 3)
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(.trailing, Tokens.Space.medium)
            .padding(.vertical, Tokens.Space.small)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Tokens.Line.border.color).frame(height: 0.5)
            }
        }
    }

    private func label(_ item: CalendarItem) -> String? {
        let total = CalendarDates.spanDays(item)
        guard total > 1 else { return nil }
        let index = CalendarDates.dayIndex(day) - CalendarDates.dayIndex(CalendarDates.spanStart(item)) + 1
        return CalendarCopy.dayOf(index, total)
    }
}
