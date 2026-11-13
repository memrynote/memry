import MemryCore
import SwiftUI

// #4352, `DESIGN.md` › Tablet. Month at regular width, after desktop's
// `calendar-month-view.tsx`: the weeks share the pane's height, a cell lists
// its items as titled chips while they fit and "+N" for the rest, multi-day
// spans run across the week under the day numbers, and the selected day's
// agenda sits in a `Tokens.Size.rail` side column. The chips only show: a
// tap on the cell selects the day, whose agenda rows (44pt) open the items.

extension CalendarMonthView {
    func regularLayout(grid: [String], items: [CalendarItem]) -> some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                weekdayHeader(grid)
                VStack(spacing: 0) {
                    ForEach(0 ..< grid.count / 7, id: \.self) { row in
                        CalendarMonthWeekRow(
                            week: Array(grid[row * 7 ..< row * 7 + 7]),
                            items: items,
                            store: store,
                            selection: selectionRange
                        )
                    }
                }
                // `rangeGesture` maps a point to a day with this inset and
                // equal rows.
                .padding(.horizontal, Tokens.Space.small)
                .onGeometryChange(for: CGSize.self) { $0.size } action: { gridSize = $0 }
                .gesture(rangeGesture(grid))
                .sensoryFeedback(.selection, trigger: dragTo)
            }
            Rectangle().fill(Tokens.Line.border.color).frame(width: 0.5)
            ScrollView {
                CalendarAgendaList(store: store, days: [store.anchor], items: items, actions: actions, showsHeader: true)
            }
            .refreshable { await store.sync() }
            .frame(width: Tokens.Size.rail)
            .accessibilityIdentifier("calendar.month.agenda")
        }
    }
}

/// How many chips fit, as a pure rule so it can be pinned by tests.
enum CalendarMonthFit {
    /// Chip rows a cell of `height` holds under its day number.
    static func slots(height: CGFloat, label: CGFloat, step: CGFloat) -> Int {
        guard step > 0 else { return 0 }
        return max(0, Int((height - label) / step))
    }

    /// Span lanes a week shows: all that fit, else all but one row, which
    /// the cells keep for "+N".
    static func lanes(_ count: Int, slots: Int) -> Int {
        count <= slots ? count : max(slots - 1, 0)
    }

    /// A cell's own chips, and the "+N" for its items past the room plus its
    /// spans in lanes the week hides.
    static func cell(slots: Int, lanes: Int, items: Int, hiddenSpans: Int) -> (chips: Int, more: Int) {
        let free = max(slots - lanes, 0)
        if items <= free, hiddenSpans == 0 { return (items, 0) }
        let chips = min(max(free - 1, 0), items)
        return (chips, items - chips + hiddenSpans)
    }
}

/// One week of the regular Month grid.
struct CalendarMonthWeekRow: View {
    let week: [String]
    let items: [CalendarItem]
    @Bindable var store: CalendarStore
    let selection: ClosedRange<String>?

    @ScaledMetric(relativeTo: .caption) private var chipHeight: CGFloat = 20
    private let gap: CGFloat = 2

    var body: some View {
        let spans = items.filter { $0.isSpanning && CalendarDates.isMultiDay($0) }
        let bars = CalendarLayout.spanRows(spans, week: week, key: \.projectionId, first: CalendarDates.spanStart, last: CalendarDates.spanEnd)
        let laneCount = (bars.map(\.row).max() ?? -1) + 1
        GeometryReader { proxy in
            let slots = CalendarMonthFit.slots(height: proxy.size.height - gap * 2, label: label, step: chipHeight + gap)
            let lanes = CalendarMonthFit.lanes(laneCount, slots: slots)
            let column = proxy.size.width / 7
            ZStack(alignment: .topLeading) {
                HStack(spacing: 0) {
                    ForEach(week, id: \.self) { day in
                        let hidden = bars.filter { $0.row >= lanes && (week[$0.startColumn] ... week[$0.endColumn]).contains(day) }.count
                        cell(day, slots: slots, lanes: lanes, hiddenSpans: hidden)
                            .frame(width: column)
                    }
                }
                ForEach(bars.filter { $0.row < lanes }) { bar in
                    CalendarChip(item: bar.item, now: store.clock(), showsTime: false)
                        .frame(width: column * CGFloat(bar.endColumn - bar.startColumn + 1) - gap * 2, height: chipHeight)
                        .offset(x: column * CGFloat(bar.startColumn) + gap,
                                y: gap + label + CGFloat(bar.row) * (chipHeight + gap))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
        }
        .frame(maxHeight: .infinity)
        .overlay(alignment: .top) { Rectangle().fill(Tokens.Line.border.color).frame(height: 0.5) }
    }

    /// The day number's circle and the gap under it.
    private var label: CGFloat { Tokens.Calendar.dayCircle + gap }

    private func cell(_ day: String, slots: Int, lanes: Int, hiddenSpans: Int) -> some View {
        let inMonth = day.prefix(7) == store.anchor.prefix(7)
        let isToday = day == store.today
        let isSelected = day == store.anchor
        let inSelection = selection.map { $0.contains(day) } ?? false
        let all = items.filter { CalendarDates.covers($0, day) }
        let own = all.filter { !($0.isSpanning && CalendarDates.isMultiDay($0)) }
            .sorted { ($0.isSpanning ? 0 : 1, $0.startAt) < ($1.isSpanning ? 0 : 1, $1.startAt) }
        let fit = CalendarMonthFit.cell(slots: slots, lanes: lanes, items: own.count, hiddenSpans: hiddenSpans)
        return VStack(alignment: .leading, spacing: gap) {
            Text(CalendarDates.start(of: day).formatted(.dateTime.day()))
                .font(Tokens.Typography.body.font.weight(isToday || isSelected ? .semibold : .regular))
                .foregroundStyle(isToday ? Tokens.Tint.foreground.color : (inMonth && !CalendarDates.isWeekend(day) ? Tokens.Text.primary.color : Tokens.Text.tertiary.color))
                .frame(width: Tokens.Calendar.dayCircle, height: Tokens.Calendar.dayCircle)
                .background { if isToday { Circle().fill(Tokens.Tint.base.color) } }
            if lanes > 0 {
                Color.clear.frame(height: CGFloat(lanes) * (chipHeight + gap) - gap)
            }
            ForEach(own.prefix(fit.chips), id: \.projectionId) { item in
                // The title only: a cell is too narrow for both, and the agenda has the time.
                CalendarChip(item: item, now: store.clock(), showsTime: false).frame(height: chipHeight)
            }
            if fit.more > 0 {
                Text(CalendarCopy.moreEvents(fit.more))
                    .font(Tokens.Calendar.chipMeta.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .lineLimit(1)
                    .padding(.leading, Tokens.Space.tight)
            }
        }
        .padding(gap)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            if isSelected || inSelection {
                RoundedRectangle(cornerRadius: Tokens.Radius.small).fill(Tokens.Canvas.surfaceActive.color)
            }
        }
        .clipped()
        .contentShape(.rect)
        .onTapGesture(count: 2) {
            store.state.anchorDate = day
            store.state.view = .day
        }
        .onTapGesture { store.state.anchorDate = day }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(CalendarWeekStrip.accessibleDay(day)), \(CalendarCopy.itemCount(all.count))")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { store.state.anchorDate = day }
        .accessibilityIdentifier("calendar.month.\(day)")
    }
}
