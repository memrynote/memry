import MemryCore
import SwiftUI

// Spec 007 CL030 (artboard 01). Day: the week strip paging in step with the
// day pager, the all-day strip, the hour grid scrolled to the now line on
// today, pull to refresh.

struct CalendarDayView: View {
    @Bindable var store: CalendarStore
    let actions: CalendarGridActions
    @State private var dragState: CalendarDragState?
    @State private var pageDay: String?
    @State private var baseDay: String?

    var body: some View {
        let window = CalendarPeriods.window(.day, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: .months)
        let items = store.items(in: window)
        let week = (0 ..< 7).map { CalendarDates.addDays(CalendarDates.startOfWeek(store.anchor, weekStartsOn: store.weekStartsOn), $0) }
        VStack(spacing: 0) {
            CalendarWeekStrip(days: week, selected: store.anchor, today: store.today, items: items) { day in
                store.state.anchorDate = day
            }
            .gesture(DragGesture(minimumDistance: 24).onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let forward = value.translation.width < 0
                store.state.anchorDate = CalendarDates.addDays(store.anchor, forward ? 7 : -7)
            })
            Rectangle().fill(Tokens.Line.border.color).frame(height: 0.5)
            pager(items: items)
        }
    }

    /// A run of days around a base that only moves when the anchor gets near
    /// its edge or jumps away (Today, Go to date, the week strip). Re-centring
    /// on every settle would shift the pages under a scroll that has not
    /// finished and skip days.
    private func pager(items: [CalendarItem]) -> some View {
        let base = baseDay ?? store.anchor
        let days = (-Self.reach ... Self.reach).map { CalendarDates.addDays(base, $0) }
        return ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(days, id: \.self) { day in
                    page(day: day, items: items)
                        .containerRelativeFrame(.horizontal)
                        .id(day)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollDisabled(dragState != nil)
        .scrollPosition(id: $pageDay)
        .scrollIndicators(.hidden)
        .onAppear {
            baseDay = store.anchor
            pageDay = store.anchor
        }
        .onChange(of: store.anchor) { _, anchor in
            let offset = CalendarDates.dayIndex(anchor) - CalendarDates.dayIndex(baseDay ?? anchor)
            if abs(offset) > Self.reach - 7 { baseDay = anchor }
            if pageDay != anchor { pageDay = anchor }
        }
        .onChange(of: pageDay) { _, day in
            if let day, day != store.anchor { store.state.anchorDate = day }
        }
    }

    private static let reach = 60

    private func page(day: String, items: [CalendarItem]) -> some View {
        // Paper 01: the all-day strip stays pinned above the scrolling hours.
        VStack(spacing: 0) {
        CalendarAllDayStrip(day: day, items: items, now: store.clock(), actions: actions)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    CalendarTimeGrid(
                        days: [day], items: items, today: store.today, now: store.clock(),
                        actions: actions, dragState: $dragState
                    )
                    .padding(.top, Tokens.Space.medium)
                    .padding(.bottom, Tokens.Size.minimumHitArea * 2)
                }
            }
            .scrollDisabled(dragState != nil)
            .refreshable { await store.sync() }
            .onAppear { scrollToStart(proxy, day: day) }
        }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.day.\(day)")
    }

    /// Today opens at the now line (an hour above it); other days at 8 AM.
    private func scrollToStart(_ proxy: ScrollViewProxy, day: String) {
        let hour = day == store.today ? max(CalendarDates.minutes(store.clock()) / 60 - 1, 0) : 8
        proxy.scrollTo(CalendarGridSpace.hourID(hour), anchor: .top)
    }
}

// Spec 007 CL031 (artboard 03). Week: seven columns, the span row, today's
// column tinted, swiped a week at a time, starting on the synced week start.
struct CalendarWeekView: View {
    @Bindable var store: CalendarStore
    let actions: CalendarGridActions
    @State private var dragState: CalendarDragState?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let window = CalendarPeriods.window(.week, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: .months)
        let items = store.items(in: window)
        let first = CalendarDates.startOfWeek(store.anchor, weekStartsOn: store.weekStartsOn)
        let days = (0 ..< 7).map { CalendarDates.addDays(first, $0) }
        VStack(spacing: 0) {
            CalendarWeekStrip(days: days, selected: store.anchor, today: store.today, items: []) { day in
                store.state.anchorDate = day
                store.state.view = .day
            }
            if typeSize.isAccessibilitySize {
                // Seven columns cannot hold AX text: the week reads as a list.
                CalendarAgendaList(store: store, days: days, items: items, actions: actions)
            } else {
                CalendarWeekSpanRow(days: days, items: items, now: store.clock(), actions: actions)
                ScrollViewReader { proxy in
                    ScrollView {
                        CalendarTimeGrid(
                            days: days, items: items, today: store.today, now: store.clock(),
                            actions: actions, dragState: $dragState
                        )
                        .background(alignment: .topLeading) { todayTint(days: days) }
                        .padding(.top, Tokens.Space.medium)
                        .padding(.bottom, Tokens.Size.minimumHitArea * 2)
                    }
                    .scrollDisabled(dragState != nil)
                    .refreshable { await store.sync() }
                    .onAppear { proxy.scrollTo(CalendarGridSpace.hourID(8), anchor: .top) }
                }
            }
        }
        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
            guard dragState == nil, abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
            store.state.anchorDate = CalendarDates.addDays(store.anchor, value.translation.width < 0 ? 7 : -7)
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.week")
    }

    private func todayTint(days: [String]) -> some View {
        GeometryReader { proxy in
            if let index = days.firstIndex(of: store.today) {
                let width = (proxy.size.width - Tokens.Calendar.gutterWidth - Tokens.Space.medium) / 7
                Rectangle()
                    .fill(Tokens.Tint.base.color.opacity(0.05))
                    .frame(width: width)
                    .offset(x: Tokens.Calendar.gutterWidth + CGFloat(index) * width)
            }
        }
    }
}

/// Week's all-day span row: bars laid across the seven columns.
struct CalendarWeekSpanRow: View {
    let days: [String]
    let items: [CalendarItem]
    let now: Date
    let actions: CalendarGridActions

    var body: some View {
        let bars = CalendarLayout.spanRows(
            items.filter(\.isSpanning), week: days, key: \.projectionId,
            first: CalendarDates.spanStart, last: CalendarDates.spanEnd
        )
        if !bars.isEmpty {
            let rows = (bars.map(\.row).max() ?? 0) + 1
            HStack(alignment: .top, spacing: 0) {
                Text(CalendarCopy.allDayLower)
                    .font(Tokens.Calendar.gutter.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(width: Tokens.Calendar.gutterWidth - Tokens.Space.small, alignment: .trailing)
                    .padding(.trailing, Tokens.Space.small)
                // Desktop grows the row to fit; on a phone it stops at three
                // rows and scrolls so the grid stays on screen (§6 CL031).
                ScrollView(.vertical) {
                GeometryReader { proxy in
                    let column = proxy.size.width / 7
                    ForEach(bars) { bar in
                        CalendarChip(item: bar.item, now: now)
                            .frame(width: column * CGFloat(bar.endColumn - bar.startColumn + 1) - 2, height: 22)
                            .offset(x: column * CGFloat(bar.startColumn) + 1, y: CGFloat(bar.row) * 25)
                            .onTapGesture { actions.open(bar.item) }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(CalendarItemStyle.accessibilityLabel(bar.item))
                            .accessibilityAddTraits(.isButton)
                            .accessibilityAction { actions.open(bar.item) }
                    }
                }
                .frame(height: CGFloat(rows) * 25)
                }
                .frame(height: CGFloat(min(rows, 3)) * 25 + (rows > 3 ? 12 : 0))
                .scrollBounceBehavior(.basedOnSize)
                .padding(.trailing, Tokens.Space.medium)
            }
            .padding(.vertical, Tokens.Space.small)
            .overlay(alignment: .bottom) { Rectangle().fill(Tokens.Line.border.color).frame(height: 0.5) }
        }
    }
}
