import MemryCore
import SwiftUI

// Spec 007 CL050 (artboard 17). The task sheet: status circle (complete /
// undo), title, breadcrumb (project › parent), pills (status, priority,
// tags), description, subtasks with the counter, the Move row (Later,
// Tomorrow, Next week from desktop `snooze-options.ts`), Complete / Open task,
// and … (Source note, Pick date & time, Remove due date).

/// `computeSnoozeOptions`.
enum CalendarSnoozeOptions {
    struct Target: Equatable {
        let dueDate: String
        let dueTime: String?
    }

    static func laterToday(now: Date, isAllDay: Bool) -> Target? {
        guard !isAllDay else { return nil }
        let calendar = CalendarDates.calendar
        guard calendar.component(.hour, from: now) < 19 else { return nil }
        let cap = calendar.date(bySettingHour: 20, minute: 0, second: 0, of: now) ?? now
        let target = min(max(now.addingTimeInterval(3 * 3_600), now.addingTimeInterval(3_600)), cap)
        let parts = calendar.dateComponents([.hour, .minute], from: target)
        return Target(dueDate: CalendarDates.key(target), dueTime: String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0))
    }

    static func tomorrow(now: Date, isAllDay: Bool) -> Target {
        Target(dueDate: CalendarDates.addDays(CalendarDates.key(now), 1), dueTime: isAllDay ? nil : "09:00")
    }

    static func nextWeek(now: Date, isAllDay: Bool) -> Target {
        let today = CalendarDates.key(now)
        let day = CalendarDates.weekday(today)
        return Target(dueDate: CalendarDates.addDays(today, day == 0 ? 1 : 8 - day), dueTime: isAllDay ? nil : "09:00")
    }
}

struct CalendarTaskSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @State private var task: TaskItem?
    @State private var showSubtasks = true
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksRouter.self) private var router

    /// Paper 17: breadcrumb with … and close on one line, the status circle
    /// and title, pills, description, subtasks, the Move chips, then Complete
    /// and Open task.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                topBar
                if let task {
                    header(task)
                    pills(task)
                    if let description = task.description, !description.isEmpty {
                        Text(LocalizedStringKey(description))
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                            .tint(Tokens.Text.tint.color)
                    }
                    subtasks(task)
                    moveRow(task)
                    actions(task)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
            .padding(.top, Tokens.Space.inset)
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.task")
    }

    private func load() async {
        task = await store.task(item.sourceId)
    }

    private var project: ProjectItem? {
        store.tasks?.projects.first { $0.id == task?.projectId }
    }

    private var topBar: some View {
        HStack(spacing: Tokens.Space.small) {
            Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 7, height: 7)
            Text(task.map(breadcrumb) ?? CalendarCopy.taskKind)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .lineLimit(1)
            Spacer()
            moreMenu
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .glassEffect(.regular.interactive(), in: .circle)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(CalendarCopy.close)
        }
    }

    private func header(_ task: TaskItem) -> some View {
        HStack(alignment: .top, spacing: Tokens.Space.small) {
            Button { Task { await toggle(task) } } label: {
                Image(systemName: task.completedAt == nil ? "circle" : "checkmark.circle.fill")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(task.completedAt == nil ? statusColor(task) : Tokens.Task.complete.color)
                    .frame(width: 28, height: 32)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea, alignment: .topLeading)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.completedAt == nil ? CalendarCopy.markDone : CalendarCopy.markNotDone)
            .accessibilityIdentifier("calendar.task.toggle")
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(task.title)
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .strikethrough(task.completedAt != nil)
                    .accessibilityAddTraits(.isHeader)
                Text(whenText(task))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
    }

    /// Paper 17: "Today 10:30 · Repeats monthly", read from the task itself so
    /// a Move shows its new day at once.
    private func whenText(_ task: TaskItem) -> String {
        var parts = [store.tasks?.dueLabel(task)?.text(omittingDay: false) ?? CalendarCopy.noDate]
        if task.isRepeating { parts.append(CalendarCopy.repeats) }
        return parts.joined(separator: " · ")
    }

    private func statusColor(_ task: TaskItem) -> Color {
        let type = project?.statuses.first { $0.id == task.statusId }?.statusType
        return type == "in_progress" ? Tokens.Task.progress.color : Tokens.Text.tertiary.color
    }

    private func breadcrumb(_ task: TaskItem) -> String {
        let parent = task.parentId.flatMap { store.tasks?.items[$0]?.title }
        let path = [project?.name, parent].compactMap { $0 }.joined(separator: " › ")
        return path.isEmpty ? CalendarCopy.taskKind : "\(CalendarCopy.taskKind) · \(path)"
    }

    /// Status, priority and tags, each in its own colour (Paper 17).
    private func pills(_ task: TaskItem) -> some View {
        let status = project?.statuses.first { $0.id == task.statusId }
        var values: [(String, Color)] = []
        if let status, status.statusType != "todo" {
            values.append((status.name, status.statusType == "in_progress" ? Tokens.Task.progress.color : Tokens.Task.complete.color))
        }
        if task.priority > 0 {
            let color = switch task.priority {
            case 4: Tokens.Task.priorityUrgent.color
            case 3: Tokens.Task.priorityHigh.color
            default: Tokens.Task.priorityMedium.color
            }
            values.append((CalendarCopy.timelinePriority(task.priority), color))
        }
        values += task.tags.map { ("#\($0)", Tokens.Text.secondary.color) }
        return TaskFlowLayout(horizontal: Tokens.Space.small, vertical: Tokens.Space.small) {
            ForEach(values, id: \.0) { value in
                Text(value.0)
                    .font(Tokens.Typography.caption.font.weight(.medium))
                    .foregroundStyle(value.1)
                    .padding(.horizontal, Tokens.Space.medium)
                    .frame(minHeight: Tokens.Size.pill)
                    .background(Tokens.Canvas.surface.color, in: .capsule)
            }
        }
    }

    private func moveRow(_ task: TaskItem) -> some View {
        let now = store.clock()
        let allDay = task.dueTime == nil
        return HStack(spacing: Tokens.Space.small) {
            if let later = CalendarSnoozeOptions.laterToday(now: now, isAllDay: allDay) {
                moveButton(CalendarCopy.laterAt(later.dueTime ?? ""), later)
            }
            moveButton(CalendarCopy.tomorrow, CalendarSnoozeOptions.tomorrow(now: now, isAllDay: allDay))
            moveButton(CalendarCopy.nextWeek, CalendarSnoozeOptions.nextWeek(now: now, isAllDay: allDay))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarCopy.move)
    }

    private func moveButton(_ title: String, _ target: CalendarSnoozeOptions.Target) -> some View {
        Button {
            Task {
                await store.taskWrite(item.sourceId, message: CalendarCopy.taskRescheduled) { core, id in
                    try core.setDue(id: id, date: target.dueDate, time: target.dueTime)
                }
                await load()
            }
        } label: {
            Text(title)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea - 8)
                .background(Tokens.Canvas.surface.color, in: .capsule)
                .frame(minHeight: Tokens.Size.minimumHitArea)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.task.move.\(title)")
    }

    @ViewBuilder
    private func subtasks(_ task: TaskItem) -> some View {
        let children = (store.tasks?.ordered ?? []).filter { $0.parentId == task.id && $0.archivedAt == nil }
        if !children.isEmpty {
            let done = children.filter { $0.completedAt != nil }.count
            DisclosureGroup(isExpanded: $showSubtasks) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(children, id: \.id) { child in
                        HStack(spacing: Tokens.Space.medium) {
                            Image(systemName: child.completedAt == nil ? "circle.dashed" : "checkmark.circle.fill")
                                .foregroundStyle(child.completedAt == nil ? Tokens.Text.tertiary.color : Tokens.Task.complete.color)
                            Text(child.title)
                                .foregroundStyle(child.completedAt == nil ? Tokens.Text.primary.color : Tokens.Text.tertiary.color)
                                .strikethrough(child.completedAt != nil)
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                    }
                }
            } label: {
                Text("\(CalendarCopy.subtasks) · \(CalendarCopy.subtasksCounter(done, children.count))")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .tint(Tokens.Text.secondary.color)
        }
    }

    /// The one primary action (Complete) and Open task.
    private func actions(_ task: TaskItem) -> some View {
        HStack(spacing: Tokens.Space.small) {
            Button { Task { await toggle(task) } } label: {
                Text(task.completedAt == nil ? CalendarCopy.complete : CalendarCopy.uncomplete)
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Tint.foreground.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            }
            .buttonStyle(.glassProminent)
            .tint(Tokens.Tint.base.color)
            .accessibilityIdentifier("calendar.task.complete")
            Button { open() } label: {
                Text(CalendarCopy.openTask)
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("calendar.task.open")
        }
        .padding(.top, Tokens.Space.small)
    }

    private var moreMenu: some View {
        Menu {
            if let note = task?.sourceNoteId {
                Button { router.settingsPath.append(NoteRoute(id: note)); dismiss() } label: {
                    Label(CalendarCopy.sourceNote, systemImage: "doc.text")
                }
            }
            Button { open() } label: { Label(CalendarCopy.pickDateTime, systemImage: "calendar") }
            Button(role: .destructive) {
                Task {
                    await store.taskWrite(item.sourceId, message: CalendarCopy.removedDue) { core, id in
                        try core.setDue(id: id, date: nil, time: nil)
                    }
                    dismiss()
                }
            } label: { Label(CalendarCopy.removeDueDate, systemImage: "calendar.badge.minus") }
        } label: {
            Image(systemName: "ellipsis").foregroundStyle(Tokens.Text.primary.color)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
        }
        .accessibilityLabel(CalendarCopy.moreActions)
        .accessibilityIdentifier("calendar.task.more")
    }

    /// Open task / Pick date & time: the task's detail in Tasks, where the
    /// When sheet lives (lane E).
    private func open() {
        dismiss()
        router.openTask(item.sourceId)
    }

    private func toggle(_ task: TaskItem) async {
        let completed = task.completedAt != nil
        let now = store.tasks?.localNow() ?? ""
        await store.taskWrite(task.id, message: completed ? nil : CalendarCopy.taskCompleted) { core, id in
            completed ? try core.uncomplete(id: id) : try core.complete(id: id, localNow: now).change
        }
        await load()
    }
}

extension CalendarCopy {
    static let removedDue = "Due date removed"
    static let noDate = "No date"
    static let repeats = "Repeats"
    /// Paper 17: "Later, 13:30".
    static func laterAt(_ time: String) -> String {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2,
              let date = CalendarDates.calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date())
        else { return laterToday }
        return "\(laterToday), \(CalendarItemStyle.time(date))"
    }
}
