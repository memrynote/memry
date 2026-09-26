import MemryCore
import SwiftUI

// Spec 007 CL033 (artboards 05, 06). Year: twelve mini months with tinted
// month names and today marked; a day with items shows a dot. Tap a day for
// the peek sheet, tap a month name for Month.

struct CalendarYearView: View {
    @Bindable var store: CalendarStore
    let peek: (String) -> Void

    /// Paper 05: three months a row; at accessibility sizes two.
    @Environment(\.dynamicTypeSize) private var typeSize
    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: Tokens.Space.medium, alignment: .top),
              count: typeSize.isAccessibilitySize ? 2 : 3)
    }

    var body: some View {
        let window = CalendarPeriods.window(.year, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: .months)
        let items = store.items(in: window)
        let busy = Set(items.flatMap { item -> [String] in
            let first = CalendarDates.spanStart(item)
            return (0 ..< CalendarDates.spanDays(item)).map { CalendarDates.addDays(first, $0) }
        })
        let year = String(store.anchor.prefix(4))
        ScrollView {
            LazyVGrid(columns: columns, spacing: Tokens.Space.inset) {
                ForEach(1 ... 12, id: \.self) { month in
                    miniMonth(String(format: "%@-%02d-01", year, month), busy: busy)
                }
            }
            .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
            .padding(.bottom, Tokens.Size.minimumHitArea * 2)
        }
        .refreshable { await store.sync() }
        .gesture(DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
            store.state.anchorDate = CalendarDates.addYears(store.anchor, value.translation.width < 0 ? 1 : -1)
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.year")
    }

    private func miniMonth(_ first: String, busy: Set<String>) -> some View {
        let grid = CalendarDates.monthGrid(first, weekStartsOn: store.weekStartsOn)
        return VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Button {
                store.state.anchorDate = first
                store.state.view = .month
            } label: {
                Text(CalendarDates.start(of: first).formatted(.dateTime.month(.wide)))
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.tint.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("calendar.year.month.\(first.prefix(7))")
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(0 ..< grid.count / 7, id: \.self) { row in
                    GridRow {
                        ForEach(grid[row * 7 ..< row * 7 + 7], id: \.self) { day in
                            dayCell(day, inMonth: day.prefix(7) == first.prefix(7), busy: busy.contains(day))
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func dayCell(_ day: String, inMonth: Bool, busy: Bool) -> some View {
        if inMonth {
            let isToday = day == store.today
            Button { peek(day) } label: {
                VStack(spacing: 0) {
                    Text(CalendarDates.start(of: day).formatted(.dateTime.day()))
                        .font(Tokens.Calendar.yearDay.font.weight(isToday ? .bold : .regular))
                        .foregroundStyle(isToday ? Tokens.Tint.foreground.color : Tokens.Text.primary.color)
                        .lineLimit(1)
                        .fixedSize()
                        .frame(width: 16, height: 16)
                        .background { if isToday { Circle().fill(Tokens.Tint.base.color) } }
                    Circle()
                        .fill(busy ? Tokens.Text.tertiary.color : .clear)
                        .frame(width: 2.5, height: 2.5)
                }
                .frame(maxWidth: .infinity)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CalendarWeekStrip.accessibleDay(day))
            .accessibilityIdentifier("calendar.year.\(day)")
        } else {
            Color.clear.frame(maxWidth: .infinity, minHeight: 18.5)
        }
    }
}

/// Artboard 06: the day's items in a medium sheet, each opening its item,
/// and Open day.
struct CalendarDayPeekSheet: View {
    @Bindable var store: CalendarStore
    let day: String
    let open: (CalendarItem) -> Void
    let openDay: () -> Void
    @State private var items: [CalendarItem] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if items.isEmpty {
                    Text(CalendarCopy.noEvents).foregroundStyle(Tokens.Text.tertiary.color)
                }
                ForEach(items, id: \.projectionId) { item in
                    Button { open(item) } label: {
                        HStack(spacing: Tokens.Space.medium) {
                            Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 8, height: 8)
                            Text(item.title).foregroundStyle(Tokens.Text.primary.color)
                            Spacer()
                            Text(item.isSpanning ? CalendarCopy.allDay : CalendarItemStyle.time(item.startDate))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                    }
                    .accessibilityLabel(CalendarItemStyle.accessibilityLabel(item))
                }
            }
            .listStyle(.plain)
            .navigationTitle(CalendarDates.start(of: day).formatted(.dateTime.weekday(.wide).month(.wide).day()))
            .navigationSubtitle(CalendarCopy.itemCount(items.count))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(CalendarCopy.openDay, action: openDay).accessibilityIdentifier("calendar.peek.openDay")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            let window = CalendarWindow(
                startAt: CalendarDates.iso(CalendarDates.start(of: day)),
                endAt: CalendarDates.iso(CalendarDates.start(of: CalendarDates.addDays(day, 1)))
            )
            await store.ensure(window)
            items = store.items(in: window).filter { CalendarDates.covers($0, day) }
        }
    }
}
