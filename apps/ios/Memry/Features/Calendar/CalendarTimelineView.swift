import MemryCore
import SwiftUI

// Spec 007 CL034 (artboard 07). The timeline: zoom segmented control, a pinned
// title column beside one horizontally scrolling canvas (axis, bars, due
// diamonds, open-ended fades, the today line), grouped rows. Tap selects a
// bar, dragging a selected bar moves it and its ends resize it, a tap on an
// undated row's day dates it; every change offers Undo.

struct CalendarTimelineView: View {
    @Bindable var store: CalendarStore
    let openItem: (CalendarItem) -> Void
    @State private var selected: String?
    @State private var drag: (id: String, edit: TimelineModel.Edit, days: Int)?
    @State var actionTask: TimelineTaskTarget?
    @Environment(TasksRouter.self) var router

    static let titleWidth: CGFloat = 132
    static let rowHeight: CGFloat = 36
    static let axisHeight: CGFloat = 40

    static func groups(_ store: CalendarStore) -> (window: TimelineModel.Window, groups: [TimelineModel.Group]) {
        let settings = store.state.timeline
        let window = TimelineModel.window(anchor: store.anchor, zoom: settings.zoom, weekStartsOn: store.weekStartsOn)
        let range = CalendarPeriods.window(.timeline, anchor: store.anchor, weekStartsOn: store.weekStartsOn, zoom: settings.zoom)
        let groups = TimelineModel.groups(
            tasks: store.tasks?.ordered ?? [],
            projects: store.tasks?.projects ?? [],
            events: store.items(in: range),
            window: window, today: store.today, settings: settings
        )
        return (window, groups)
    }

    /// The header subtitle: grouping and what the rows hold.
    static func summary(_ store: CalendarStore) -> String {
        let rows = groups(store).groups.flatMap(\.rows)
        let tasks = rows.filter { if case .task = $0 { true } else { false } }.count
        return CalendarCopy.timelineSummary(store.state.timeline.groupBy, tasks: tasks, events: rows.count - tasks)
    }

    var body: some View {
        let settings = store.state.timeline
        let (window, groups) = Self.groups(store)
        let dayWidth = CGFloat(TimelineModel.dayWidth(settings.zoom))
        VStack(spacing: Tokens.Space.small) {
            Picker(CalendarCopy.zoom, selection: $store.state.timeline.zoom) {
                ForEach(TimelineZoom.allCases) { Text(CalendarCopy.zoom($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
            .accessibilityIdentifier("calendar.timeline.zoom")
            if groups.isEmpty {
                ContentUnavailableView(CalendarCopy.timelineEmptyTitle, systemImage: "chart.bar.xaxis", description: Text(CalendarCopy.timelineEmptyBody))
            } else {
                ScrollView(.vertical) {
                    HStack(alignment: .top, spacing: 0) {
                        titleColumn(groups)
                        ScrollViewReader { proxy in
                            ScrollView(.horizontal) {
                                canvas(groups, window: window, dayWidth: dayWidth)
                            }
                            .scrollIndicators(.hidden)
                            .onAppear { proxy.scrollTo("timeline.today", anchor: .center) }
                        }
                    }
                    .padding(.bottom, Tokens.Size.minimumHitArea * 2)
                }
                .refreshable { await store.sync() }
            }
        }
        .task { if let tasks = store.tasks, tasks.ordered.isEmpty { await tasks.load() } }
        .sheet(item: $actionTask) { target in CalendarTimelineDateSheet(store: store, task: target.task) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.timeline")
    }

    // MARK: Title column

    private func titleColumn(_ groups: [TimelineModel.Group]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Paper 07: "Tasks · Sep" names the column and the anchor month.
            Text("\(CalendarCopy.timelineTasks) · \(CalendarDates.start(of: store.anchor).formatted(.dateTime.month(.abbreviated)))")
                .font(Tokens.Calendar.chipMeta.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(height: Self.axisHeight, alignment: .bottomLeading)
                .padding(.bottom, Tokens.Space.tight)
            ForEach(groups) { group in
                // Paper 07: a dot in the group's colour, the name, the count.
                HStack(spacing: Tokens.Space.tight + 1) {
                    Circle()
                        .fill(group.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color }
                            ?? (group.heading == .events ? Tokens.Calendar.indigo.rail.color : Tokens.Text.tertiary.color))
                        .frame(width: 6, height: 6)
                    Text(heading(group.heading))
                        .font(Tokens.Typography.caption.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(1)
                    if group.heading != .events {
                        Text("\(group.rows.count)")
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
                .padding(.bottom, Tokens.Space.tight)
                .frame(height: Self.rowHeight, alignment: .bottomLeading)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                ForEach(group.rows) { row in
                    rowTitle(row)
                        .frame(height: Self.rowHeight, alignment: .leading)
                }
            }
        }
        .frame(width: Self.titleWidth, alignment: .leading)
        .padding(.leading, Tokens.Space.inset)
        .background(Tokens.Canvas.background.color)
    }

    @ViewBuilder
    private func rowTitle(_ row: TimelineModel.Row) -> some View {
        switch row {
        case let .task(task):
            Button { openTask(task.task) } label: {
                Text(task.task.title.isEmpty ? CalendarCopy.untitled : task.task.title)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(task.isCompleted ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                    .strikethrough(task.isCompleted)
                    .lineLimit(1)
                    .padding(.leading, CGFloat(task.depth) * Tokens.Space.medium)
            }
            .buttonStyle(.plain)
        case let .event(event):
            Text(event.item.title)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1)
        }
    }

    private func heading(_ heading: TimelineModel.Heading) -> String {
        switch heading {
        case .events: CalendarCopy.timelineEvents
        case let .project(_, name): name
        case let .status(status): CalendarCopy.timelineStatus(status)
        case let .priority(priority): CalendarCopy.timelinePriority(priority)
        case .all: CalendarCopy.timelineTasks
        }
    }

    // MARK: Canvas

    private func canvas(_ groups: [TimelineModel.Group], window: TimelineModel.Window, dayWidth: CGFloat) -> some View {
        let width = CGFloat(window.dayCount) * dayWidth
        let todayX = max(0, CGFloat(TimelineModel.offset(store.today, window)) * dayWidth)
        return VStack(alignment: .leading, spacing: 0) {
            // The scroll anchor for today: a laid-out frame (offsets do not move
            // a view's frame, so `scrollTo` cannot find an offset view).
            HStack(spacing: 0) {
                Color.clear.frame(width: todayX, height: 0)
                Color.clear.frame(width: 1, height: 0).id("timeline.today")
            }
            CalendarTimelineAxis(
                window: window, dayWidth: dayWidth, zoom: store.state.timeline.zoom,
                today: store.today, weekStartsOn: store.weekStartsOn
            )
                .frame(width: width, height: Self.axisHeight)
            ForEach(groups) { group in
                summaryRow(group, dayWidth: dayWidth).frame(width: width, height: Self.rowHeight)
                ForEach(group.rows) { row in
                    barRow(row, window: window, dayWidth: dayWidth)
                        .frame(width: width, height: Self.rowHeight)
                }
            }
        }
        .overlay(alignment: .topLeading) {
            let offset = CGFloat(TimelineModel.offset(store.today, window)) * dayWidth + dayWidth / 2
            if offset >= 0, offset <= width {
                Rectangle().fill(Tokens.Tint.base.color).frame(width: 1.5).offset(x: offset)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private func summaryRow(_ group: TimelineModel.Group, dayWidth: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            if let summary = group.summary {
                Capsule()
                    .fill((group.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color).opacity(0.35))
                    .frame(width: CGFloat(summary.to - summary.from + 1) * dayWidth, height: 3)
                    .offset(x: CGFloat(summary.from) * dayWidth)
            }
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, Tokens.Space.tight)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func barRow(_ row: TimelineModel.Row, window: TimelineModel.Window, dayWidth: CGFloat) -> some View {
        switch row {
        case let .event(event):
            let hue = CalendarItemStyle.hue(event.item)
            RoundedRectangle(cornerRadius: Tokens.Calendar.chipRadius)
                .fill(hue.surface.color)
                .overlay(alignment: .leading) { Rectangle().fill(hue.rail.color).frame(width: Tokens.Calendar.railWidth) }
                .frame(width: CGFloat(event.placement.to - event.placement.from + 1) * dayWidth - 2, height: Self.rowHeight - 12)
                .offset(x: CGFloat(event.placement.from) * dayWidth + 1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onTapGesture { openItem(event.item) }
                .accessibilityElement()
                .accessibilityLabel(CalendarItemStyle.accessibilityLabel(event.item))
                .accessibilityAddTraits(.isButton)
        case let .task(task):
            CalendarTimelineBar(
                row: task, window: window, dayWidth: dayWidth, rowHeight: Self.rowHeight,
                isSelected: selected == task.id,
                select: { selected = selected == task.id ? nil : task.id },
                edit: { edit, days in Task { await apply(task, edit: edit, days: days) } },
                schedule: { day in Task { await schedule(task, day: day) } },
                menu: { AnyView(barMenu(task)) },
                preview: { AnyView(barPreview(task)) }
            )
        }
    }

    // MARK: Actions

    /// Open in Tasks: the task detail in the Tasks tab (lane H).
    func openTask(_ task: TaskItem) {
        router.openTask(task.id)
    }

    func apply(_ row: TimelineModel.TaskRow, edit: TimelineModel.Edit, days: Int) async {
        let dates = TimelineModel.apply(row.shape, edit, deltaDays: days)
        await setDates(row.task, dates)
    }

    func schedule(_ row: TimelineModel.TaskRow, day: String) async {
        await setDates(row.task, TimelineModel.schedule(from: day, to: day))
    }

    func setDates(_ task: TaskItem, _ dates: TimelineModel.Dates) async {
        let start = dates.start, due = dates.due, time = task.dueTime
        await store.taskWrite(task.id, message: CalendarCopy.timelineReschedule(task.title)) { core, id in
            let first = try core.setStartDate(id: id, date: start)
            let second = try core.setDue(id: id, date: due, time: due == nil ? nil : time)
            return TasksStore.merge(first, second)
        }
    }
}

/// A task a timeline sheet edits.
struct TimelineTaskTarget: Identifiable {
    let task: TaskItem
    var id: String { task.id }
}
