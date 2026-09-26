import MemryCore
import SwiftUI

// Spec 007 CL032 (artboard 04). Month: the grid with type dots, multi-day
// bars under the days, the filled today, "N more"; a tap selects a day and
// lists it below, a double tap opens Day, a long press + drag across days
// quick-creates an all-day range.

struct CalendarMonthView: View {
    @Bindable var store: CalendarStore
    let actions: CalendarGridActions
    @State private var dragFrom: String?
    @State private var dragTo: String?
    @State private var gridSize: CGSize = .zero
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let window = CalendarPeriods.window(.month, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: .months)
        let items = store.items(in: window)
        let grid = CalendarDates.monthGrid(store.anchor, weekStartsOn: store.weekStartsOn)
        ScrollView {
            VStack(spacing: 0) {
                if !typeSize.isAccessibilitySize {
                    weekdayHeader(grid)
                    VStack(spacing: 0) {
                        ForEach(0 ..< grid.count / 7, id: \.self) { row in
                            weekRow(Array(grid[row * 7 ..< row * 7 + 7]), items: items)
                        }
                    }
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { gridSize = $0 }
                    .gesture(rangeGesture(grid))
                    .sensoryFeedback(.selection, trigger: dragTo)
                }
                CalendarAgendaList(store: store, days: [store.anchor], items: items, actions: actions, showsHeader: true)
            }
        }
        .scrollDisabled(dragFrom != nil)
        .refreshable { await store.sync() }
        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
            guard dragFrom == nil, abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
            store.state.anchorDate = CalendarDates.addMonths(store.anchor, value.translation.width < 0 ? 1 : -1)
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.month")
    }

    private func weekdayHeader(_ grid: [String]) -> some View {
        HStack(spacing: 0) {
            ForEach(grid.prefix(7), id: \.self) { day in
                Text(CalendarDates.start(of: day).formatted(.dateTime.weekday(.narrow)))
                    .font(Tokens.Calendar.weekdayLetter.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, Tokens.Space.small)
        .padding(.bottom, Tokens.Space.tight)
        .accessibilityHidden(true)
    }

    private func weekRow(_ week: [String], items: [CalendarItem]) -> some View {
        let spans = items.filter { $0.isSpanning && CalendarDates.isMultiDay($0) }
        let bars = CalendarLayout.spanRows(spans, week: week, key: \.projectionId, first: CalendarDates.spanStart, last: CalendarDates.spanEnd)
        return VStack(spacing: 2) {
            HStack(spacing: 0) {
                ForEach(week, id: \.self) { day in dayCell(day, items: items) }
            }
            GeometryReader { proxy in
                let column = proxy.size.width / 7
                ForEach(bars.filter { $0.row < 2 }) { bar in
                    Capsule()
                        .fill(CalendarItemStyle.hue(bar.item).rail.color)
                        .frame(width: column * CGFloat(bar.endColumn - bar.startColumn + 1) - 6, height: 4)
                        .offset(x: column * CGFloat(bar.startColumn) + 3, y: CGFloat(bar.row) * 6)
                        .accessibilityHidden(true)
                }
            }
            .frame(height: bars.isEmpty ? 0 : 10)
        }
        .padding(.horizontal, Tokens.Space.small)
        .padding(.vertical, Tokens.Space.tight)
        .overlay(alignment: .top) { Rectangle().fill(Tokens.Line.border.color).frame(height: 0.5) }
    }

    private func dayCell(_ day: String, items: [CalendarItem]) -> some View {
        let inMonth = day.prefix(7) == store.anchor.prefix(7)
        let isToday = day == store.today
        let isSelected = day == store.anchor
        let dayItems = items.filter { CalendarDates.covers($0, day) }
        let selectedRange = selectionRange
        let inSelection = selectedRange.map { $0.contains(day) } ?? false
        return VStack(spacing: Tokens.Space.tight) {
            Text(CalendarDates.start(of: day).formatted(.dateTime.day()))
                .font(Tokens.Typography.body.font.weight(isToday || isSelected ? .semibold : .regular))
                .foregroundStyle(isToday ? Tokens.Tint.foreground.color : (inMonth && !CalendarDates.isWeekend(day) ? Tokens.Text.primary.color : Tokens.Text.tertiary.color))
                .frame(width: Tokens.Calendar.dayCircle, height: Tokens.Calendar.dayCircle)
                .background {
                    if isToday { Circle().fill(Tokens.Tint.base.color) }
                    else if isSelected || inSelection { Circle().fill(Tokens.Canvas.surfaceActive.color) }
                }
            CalendarDayDots(items: dayItems)
            if dayItems.count > 3 {
                Text("+\(dayItems.count - 3)")
                    .font(Tokens.Calendar.chipMeta.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityLabel(CalendarCopy.moreEvents(dayItems.count - 3))
            }
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea + Tokens.Space.small, alignment: .top)
        .contentShape(.rect)
        .onTapGesture(count: 2) {
            store.state.anchorDate = day
            store.state.view = .day
        }
        .onTapGesture { store.state.anchorDate = day }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(CalendarWeekStrip.accessibleDay(day)), \(CalendarCopy.itemCount(dayItems.count))")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { store.state.anchorDate = day }
        .accessibilityIdentifier("calendar.month.\(day)")
    }

    /// Long press a day, drag across days: an all-day range (desktop
    /// `use-month-grid-marquee.ts`).
    private func rangeGesture(_ grid: [String]) -> CalendarHoldDrag {
        let rows = max(grid.count / 7, 1)
        let cell = CGSize(width: (gridSize.width - Tokens.Space.small * 2) / 7, height: gridSize.height / CGFloat(rows))
        let dayAt = { (point: CGPoint) -> String? in
            guard cell.width > 0, cell.height > 0 else { return nil }
            let column = Int((point.x - Tokens.Space.small) / cell.width)
            let row = Int(point.y / cell.height)
            guard (0 ..< 7).contains(column), (0 ..< rows).contains(row) else { return nil }
            return grid[row * 7 + column]
        }
        return CalendarHoldDrag(minimumDuration: 0.4, isEnabled: actions.selectDays != nil) { phase in
            switch phase {
            case let .began(location):
                dragFrom = dayAt(location)
                dragTo = dragFrom
            case let .changed(_, location):
                dragTo = dayAt(location) ?? dragTo
            case let .ended(_, _, completed):
                defer { dragFrom = nil; dragTo = nil }
                guard completed, let range = selectionRange, range.lowerBound != range.upperBound else { return }
                actions.selectDays?(range.lowerBound, range.upperBound)
            }
        }
    }

    private var selectionRange: ClosedRange<String>? {
        guard let dragFrom, let dragTo else { return nil }
        return min(dragFrom, dragTo) ... max(dragFrom, dragTo)
    }
}

/// A day's items as a list: Month's selected day, Week and Month at AX sizes.
struct CalendarAgendaList: View {
    @Bindable var store: CalendarStore
    let days: [String]
    let items: [CalendarItem]
    let actions: CalendarGridActions
    var showsHeader = true

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(days, id: \.self) { day in
                let dayItems = items.filter { CalendarDates.covers($0, day) }
                    .sorted { ($0.isSpanning ? 0 : 1, $0.startAt) < ($1.isSpanning ? 0 : 1, $1.startAt) }
                if showsHeader {
                    HStack(spacing: Tokens.Space.small) {
                        Text(CalendarDates.start(of: day).formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                            .font(Tokens.Typography.supporting.font.weight(.semibold))
                            .foregroundStyle(Tokens.Text.primary.color)
                        Text("\(dayItems.count)")
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                    .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
                    .padding(.top, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.small)
                    .accessibilityAddTraits(.isHeader)
                }
                if dayItems.isEmpty {
                    Text(CalendarCopy.noEvents)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
                        .padding(.vertical, Tokens.Space.small)
                }
                ForEach(dayItems, id: \.projectionId) { item in
                    CalendarAgendaRow(item: item, day: day, now: store.clock(), actions: actions)
                }
            }
        }
        .padding(.bottom, Tokens.Size.minimumHitArea * 2)
    }
}

/// One agenda row (Paper 04 list): rail, title, "time · type · calendar".
struct CalendarAgendaRow: View {
    let item: CalendarItem
    let day: String
    let now: Date
    let actions: CalendarGridActions

    var body: some View {
        let hue = CalendarItemStyle.hue(item)
        Button { actions.open(item) } label: {
            HStack(alignment: .top, spacing: Tokens.Space.medium) {
                RoundedRectangle(cornerRadius: 2).fill(hue.rail.color).frame(width: 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .multilineTextAlignment(.leading)
                    Text(meta)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if item.visualType == "task" {
                    Button { actions.complete(item) } label: {
                        Image(systemName: "circle.dashed")
                            .font(Tokens.Typography.body.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                            .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(CalendarCopy.completeTask(item.title))
                }
            }
            .padding(.vertical, Tokens.Space.small)
            .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .opacity(item.isEnded(now: now) ? Tokens.Calendar.endedOpacity : 1)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .calendarItemMenu(actions.contextMenu, item: item)
        .accessibilityLabel(CalendarItemStyle.accessibilityLabel(item))
        .accessibilityIdentifier("calendar.row.\(item.projectionId)")
    }

    private var meta: String {
        var parts: [String] = []
        if item.isSpanning {
            let total = CalendarDates.spanDays(item)
            parts.append(total > 1 ? "\(CalendarCopy.allDay) · \(CalendarCopy.dayOf(CalendarDates.dayIndex(day) - CalendarDates.dayIndex(CalendarDates.spanStart(item)) + 1, total))" : CalendarCopy.allDay)
        } else {
            parts.append(item.endDate.map { "\(CalendarItemStyle.time(item.startDate)) – \(CalendarItemStyle.time($0))" } ?? CalendarItemStyle.time(item.startDate))
        }
        if item.visualType != "event" && item.visualType != "external_event" {
            parts.append(CalendarCopy.visualType(item.visualType))
        }
        parts.append(item.source.title)
        return parts.joined(separator: " · ")
    }
}
