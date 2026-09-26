import MemryCore
import SwiftUI

// Spec 007 CL034/CL035 (artboards 07, 08, 09). The timeline's pieces: one
// task bar (span, due diamond, open-ended fade, overdue red, undated hint),
// the axis, the Display menu and the bar's action menu.

struct CalendarTimelineBar: View {
    let row: TimelineModel.TaskRow
    let window: TimelineModel.Window
    let dayWidth: CGFloat
    let rowHeight: CGFloat
    let isSelected: Bool
    let select: () -> Void
    let edit: (TimelineModel.Edit, Int) -> Void
    let schedule: (String) -> Void
    let menu: () -> AnyView
    var preview: (() -> AnyView)?
    @State private var translation: CGFloat = 0
    @State private var editing: TimelineModel.Edit?

    var body: some View {
        ZStack(alignment: .leading) {
            if case .none = row.shape {
                undated
            } else if let placement = row.placement {
                bar(placement)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var color: Color {
        if row.isOverdue { return Tokens.Task.dueOverdue.color }
        return Tokens.Calendar.hue(hex: row.color)?.rail.color ?? Tokens.Calendar.green.rail.color
    }

    private var deltaDays: Int { Int((translation / dayWidth).rounded()) }

    @ViewBuilder
    private func bar(_ placement: TimelineModel.Placement) -> some View {
        let shift = CGFloat(deltaDays) * dayWidth
        let from = CGFloat(placement.from) * dayWidth
        let width = CGFloat(placement.to - placement.from + 1) * dayWidth
        let x = editing == .move || editing == .resizeStart ? from + shift : from
        let w = switch editing {
        case .resizeEnd: max(width + shift, dayWidth)
        case .resizeStart: max(width - shift, dayWidth)
        default: width
        }
        Group {
            if case .due = row.shape {
                Image(systemName: "diamond.fill")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(color)
                    .frame(width: max(w, Tokens.Size.minimumHitArea / 2), height: rowHeight - 12)
            } else {
                Capsule()
                    .fill(color.opacity(row.isCompleted ? 0.3 : 0.85))
                    .mask {
                        if case .start = row.shape {
                            LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .leading, endPoint: .trailing)
                        } else {
                            Rectangle()
                        }
                    }
                    .frame(width: w - 2, height: rowHeight - 16)
            }
        }
        .overlay {
            if isSelected {
                Capsule().strokeBorder(Tokens.Line.focus.color, lineWidth: 2)
            }
        }
        .overlay(alignment: .leading) { if isSelected { handle(.resizeStart) } }
        .overlay(alignment: .trailing) { if isSelected { handle(.resizeEnd) } }
        .offset(x: x + 1)
        .onTapGesture(perform: select)
        .highPriorityGesture(isSelected ? moveGesture(.move) : nil)
        .contextMenu { menu() } preview: { (preview?() ?? AnyView(EmptyView())) }
        .sensoryFeedback(.selection, trigger: deltaDays)
        .accessibilityElement()
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: CalendarCopy.moveWeekEarlier) { edit(.move, -7) }
        .accessibilityAction(named: CalendarCopy.moveWeekLater) { edit(.move, 7) }
    }

    private func handle(_ edge: TimelineModel.Edit) -> some View {
        Capsule()
            .fill(Tokens.Line.focus.color)
            .frame(width: 4, height: rowHeight - 20)
            .frame(width: 22, height: rowHeight)
            .contentShape(.rect)
            .gesture(moveGesture(edge))
            .accessibilityHidden(true)
    }

    private func moveGesture(_ edit: TimelineModel.Edit) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                editing = edit
                translation = value.translation.width
            }
            .onEnded { _ in
                let days = deltaDays
                translation = 0
                editing = nil
                if days != 0 { self.edit(edit, days) }
            }
    }

    /// An undated row: a faint dash track; a tap on a day dates the task.
    private var undated: some View {
        GeometryReader { proxy in
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(height: 1)
                .frame(maxHeight: .infinity)
                .contentShape(.rect)
                .onTapGesture { location in
                    let offset = Int(location.x / dayWidth)
                    guard offset >= 0, offset < window.dayCount else { return }
                    schedule(CalendarDates.addDays(window.start, offset))
                }
                .frame(width: proxy.size.width)
        }
        .accessibilityElement()
        .accessibilityLabel("\(row.task.title), \(CalendarCopy.timelineNoDate)")
        .accessibilityHint(CalendarCopy.timelineScheduleHint)
    }

    private var accessibility: String {
        var parts = [row.task.title]
        switch row.shape {
        case let .span(start, end): parts.append(CalendarCopy.timelineSpan(start, end))
        case let .due(date): parts.append(CalendarCopy.timelineDue(date))
        case let .start(date): parts.append(CalendarCopy.timelineStarts(date))
        case .none: parts.append(CalendarCopy.timelineNoDate)
        }
        if row.isOverdue { parts.append(CalendarCopy.timelineOverdue) }
        return parts.joined(separator: ", ")
    }
}

/// One row of date ticks (Paper 07).
struct CalendarTimelineAxis: View {
    let window: TimelineModel.Window
    let dayWidth: CGFloat
    let zoom: TimelineZoom
    let today: String
    let weekStartsOn: Int

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(ticks, id: \.day) { tick in
                Text(tick.label)
                    .font(Tokens.Calendar.chipMeta.font.weight(tick.day == today ? .semibold : .regular))
                    .foregroundStyle(tick.day == today ? Tokens.Text.tint.color : Tokens.Text.tertiary.color)
                    .fixedSize()
                    .frame(width: max(dayWidth, 16), alignment: zoom == .weeks ? .center : .leading)
                    .offset(x: CGFloat(TimelineModel.offset(tick.day, window)) * dayWidth, y: 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    /// Weeks: every day; Months: week starts (Paper 07 "14 21 28 Oct 5");
    /// Quarters: month starts. The first tick of a month carries its name.
    private var ticks: [(day: String, label: String)] {
        var result: [(day: String, label: String)] = []
        var lastMonth = ""
        for offset in 0 ..< window.dayCount {
            let day = CalendarDates.addDays(window.start, offset)
            let shown = switch zoom {
            case .weeks: true
            case .months: CalendarDates.startOfWeek(day, weekStartsOn: weekStartsOn) == day
            case .quarters: day.hasSuffix("-01")
            }
            guard shown else { continue }
            let date = CalendarDates.start(of: day)
            let month = String(day.prefix(7))
            let label = if zoom == .quarters {
                date.formatted(.dateTime.month(.abbreviated))
            } else if month != lastMonth, !result.isEmpty {
                date.formatted(.dateTime.month(.abbreviated).day())
            } else {
                date.formatted(.dateTime.day())
            }
            lastMonth = month
            result.append((day, label))
        }
        return result
    }
}

/// Artboard 08: Group by ›, Order by ›, Show toggles.
struct CalendarTimelineDisplayMenu: View {
    @Binding var settings: TimelineSettings

    var body: some View {
        Menu {
            // A submenu whose second label line is the current choice (Paper 08).
            Menu {
                Picker(CalendarCopy.groupBy, selection: $settings.groupBy) {
                    ForEach(TimelineGroupBy.allCases) { Text(CalendarCopy.groupBy($0)).tag($0) }
                }
            } label: {
                Text(CalendarCopy.groupBy)
                Text(CalendarCopy.groupBy(settings.groupBy))
            }
            Menu {
                Picker(CalendarCopy.orderBy, selection: $settings.orderBy) {
                    ForEach(TimelineOrderBy.allCases) { Text(CalendarCopy.orderBy($0)).tag($0) }
                }
            } label: {
                Text(CalendarCopy.orderBy)
                Text(CalendarCopy.orderBy(settings.orderBy))
            }
            Section(CalendarCopy.show) {
                Toggle(CalendarCopy.showEvents, isOn: $settings.showEvents)
                Toggle(CalendarCopy.showUndated, isOn: $settings.showUndated)
                Toggle(CalendarCopy.showCompleted, isOn: $settings.showCompleted)
                Toggle(CalendarCopy.showSubtasks, isOn: $settings.showSubtasks)
            }
        } label: {
            Image(systemName: "slider.horizontal.3").foregroundStyle(Tokens.Text.primary.color)
        }
        .accessibilityLabel(CalendarCopy.display)
        .accessibilityIdentifier("calendar.timeline.display")
    }
}

extension CalendarTimelineView {
    /// Artboard 09: the icon row (week earlier, week later, complete), then
    /// every action of desktop's `timeline-action-panel`.
    @ViewBuilder
    /// Paper 09: three labelled buttons on top, then plain rows; the date
    /// rows carry the current value.
    func barMenu(_ row: TimelineModel.TaskRow) -> some View {
        ControlGroup {
            Button { Task { await apply(row, edit: .move, days: -7) } } label: {
                Label(CalendarCopy.moveWeekEarlier, systemImage: "chevron.backward")
            }
            Button { Task { await apply(row, edit: .move, days: 7) } } label: {
                Label(CalendarCopy.moveWeekLater, systemImage: "chevron.forward")
            }
            Button { Task { await toggleComplete(row) } } label: {
                Label(row.isCompleted ? CalendarCopy.uncomplete : CalendarCopy.complete,
                      systemImage: row.isCompleted ? "arrow.uturn.backward.circle" : "checkmark.circle")
            }
        }
        .controlGroupStyle(.menu)
        Section {
            Button(CalendarCopy.openTask) { openTask(row.task) }
            Button(CalendarCopy.openInTasks) { openTask(row.task) }
        }
        Section {
            Button { actionTask = TimelineTaskTarget(task: row.task) } label: {
                Text(CalendarCopy.setStart)
                if let start = row.task.startDate { Text(CalendarCopy.dayText(start)) }
            }
            Button { actionTask = TimelineTaskTarget(task: row.task) } label: {
                Text(CalendarCopy.setDue)
                if let due = row.task.dueDate { Text(CalendarCopy.dayText(due)) }
            }
        Menu {
            ForEach((store.tasks?.projects ?? []).filter { $0.archivedAt == nil && $0.id != row.task.projectId }, id: \.id) { project in
                Button(project.name) {
                    let target = project.id
                    Task { await store.taskWrite(row.task.id, message: nil) { core, id in try core.setProject(id: id, projectId: target) } }
                }
            }
        } label: { Text(CalendarCopy.changeProject) }
        }
        Button(CalendarCopy.clearDates, role: .destructive) {
            Task { await setDates(row.task, TimelineModel.Dates()) }
        }
    }

    /// Paper 09's lifted card: project, title, the bar on a track, the dates.
    func barPreview(_ row: TimelineModel.TaskRow) -> some View {
        let hue = Tokens.Calendar.hue(hex: row.color) ?? Tokens.Calendar.green
        let bounds = TimelineModel.bounds(row.shape)
        return VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(spacing: Tokens.Space.tight + 1) {
                Circle().fill(hue.rail.color).frame(width: 6, height: 6)
                Text("\(CalendarCopy.visualType("task")) · \(row.projectName)")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Text(row.task.title)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(2)
            if let bounds {
                let days = CalendarDates.dayIndex(bounds.last) - CalendarDates.dayIndex(bounds.first) + 1
                Capsule().fill(hue.rail.color).frame(height: 14)
                    .padding(.horizontal, Tokens.Space.inset * 2)
                    .frame(maxWidth: .infinity)
                    .background(Capsule().fill(Tokens.Canvas.surfaceActive.color))
                Text(days > 1
                    ? "\(CalendarCopy.timelineSpan(bounds.first, bounds.last)) · \(CalendarCopy.dayCount(days))"
                    : CalendarCopy.timelineDue(bounds.last))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(width: 340, alignment: .leading)
        .background(Tokens.Canvas.background.color)
    }

    func toggleComplete(_ row: TimelineModel.TaskRow) async {
        let completed = row.isCompleted
        let now = store.tasks?.localNow() ?? ""
        await store.taskWrite(row.task.id, message: completed ? nil : CalendarCopy.taskCompleted) { core, id in
            completed ? try core.uncomplete(id: id) : try core.complete(id: id, localNow: now).change
        }
    }
}

/// Set start / due dates for a task (the Tasks When sheet is task-list
/// bound; this is its date half, desktop's action-panel pages).
struct CalendarTimelineDateSheet: View {
    @Bindable var store: CalendarStore
    let task: TaskItem
    @State private var start: Date?
    @State private var due: Date?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                optionalDate(CalendarCopy.setStart, $start)
                optionalDate(CalendarCopy.setDue, $due)
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: CalendarCopy.save) {
                        let startKey = start.map(CalendarDates.key), dueKey = due.map(CalendarDates.key), time = task.dueTime
                        Task {
                            await store.taskWrite(task.id, message: CalendarCopy.timelineReschedule(task.title)) { core, id in
                                TasksStore.merge(
                                    try core.setStartDate(id: id, date: startKey),
                                    try core.setDue(id: id, date: dueKey, time: dueKey == nil ? nil : time)
                                )
                            }
                            dismiss()
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear {
            start = task.startDate.map { CalendarDates.start(of: String($0.prefix(10))) }
            due = task.dueDate.map { CalendarDates.start(of: String($0.prefix(10))) }
        }
    }

    private func optionalDate(_ title: String, _ value: Binding<Date?>) -> some View {
        Section(title) {
            if let date = value.wrappedValue {
                DatePicker(title, selection: Binding(get: { date }, set: { value.wrappedValue = $0 }), displayedComponents: .date)
                Button(CalendarCopy.clear, role: .destructive) { value.wrappedValue = nil }
            } else {
                Button(title) { value.wrappedValue = Date() }
            }
        }
    }
}
