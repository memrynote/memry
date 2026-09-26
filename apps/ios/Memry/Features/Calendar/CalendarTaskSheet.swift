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

    var body: some View {
        NavigationStack {
            List {
                if let task {
                    header(task)
                    moveRow(task)
                    if let description = task.description, !description.isEmpty {
                        Section(CalendarCopy.notes) { Text(LocalizedStringKey(description)).tint(Tokens.Text.tint.color) }
                    }
                    subtasks(task)
                } else {
                    ProgressView()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
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

    @ViewBuilder
    private func header(_ task: TaskItem) -> some View {
        Section {
            HStack(alignment: .top, spacing: Tokens.Space.medium) {
                Button { Task { await toggle(task) } } label: {
                    Image(systemName: task.completedAt == nil ? "circle" : "checkmark.circle.fill")
                        .font(Tokens.Typography.sectionTitle.font)
                        .foregroundStyle(task.completedAt == nil ? Tokens.Text.tertiary.color : Tokens.Task.complete.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(task.completedAt == nil ? CalendarCopy.markDone : CalendarCopy.markNotDone)
                .accessibilityIdentifier("calendar.task.toggle")
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    Text(breadcrumb(task))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    Text(task.title)
                        .font(Tokens.Typography.sectionTitle.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .strikethrough(task.completedAt != nil)
                    Text(CalendarSheetText.when(item))
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    pills(task)
                }
            }
        }
        .listRowBackground(Color.clear)
    }

    private func breadcrumb(_ task: TaskItem) -> String {
        let parent = task.parentId.flatMap { store.tasks?.items[$0]?.title }
        return [CalendarCopy.taskKind, project?.name, parent].compactMap { $0 }.joined(separator: " › ")
    }

    private func pills(_ task: TaskItem) -> some View {
        let status = project?.statuses.first { $0.id == task.statusId }?.name
        let priority = task.priority > 0 ? CalendarCopy.timelinePriority(task.priority) : nil
        let values = [status, priority].compactMap { $0 } + task.tags.map { "#\($0)" }
        return ScrollView(.horizontal) {
            HStack(spacing: Tokens.Space.small) {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(Tokens.Typography.caption.font)
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.pill)
                        .background(Tokens.Canvas.surface.color, in: .capsule)
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private func moveRow(_ task: TaskItem) -> some View {
        let now = store.clock()
        let allDay = task.dueTime == nil
        Section(CalendarCopy.move) {
            HStack(spacing: Tokens.Space.small) {
                if let later = CalendarSnoozeOptions.laterToday(now: now, isAllDay: allDay) {
                    moveButton(CalendarCopy.laterToday, later)
                }
                moveButton(CalendarCopy.tomorrow, CalendarSnoozeOptions.tomorrow(now: now, isAllDay: allDay))
                moveButton(CalendarCopy.nextWeek, CalendarSnoozeOptions.nextWeek(now: now, isAllDay: allDay))
            }
        }
    }

    private func moveButton(_ title: String, _ target: CalendarSnoozeOptions.Target) -> some View {
        Button(title) {
            Task {
                await store.taskWrite(item.sourceId, message: CalendarCopy.taskRescheduled) { core, id in
                    try core.setDue(id: id, date: target.dueDate, time: target.dueTime)
                }
                await load()
            }
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("calendar.task.move.\(title)")
    }

    @ViewBuilder
    private func subtasks(_ task: TaskItem) -> some View {
        let children = (store.tasks?.ordered ?? []).filter { $0.parentId == task.id && $0.archivedAt == nil }
        if !children.isEmpty {
            let done = children.filter { $0.completedAt != nil }.count
            Section {
                DisclosureGroup(isExpanded: $showSubtasks) {
                    ForEach(children, id: \.id) { child in
                        Label(child.title, systemImage: child.completedAt == nil ? "circle" : "checkmark.circle.fill")
                    }
                } label: {
                    Text("\(CalendarCopy.subtasks) · \(CalendarCopy.subtasksCounter(done, children.count))")
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            CalendarCloseButton { dismiss() }
        }
        ToolbarItemGroup(placement: .confirmationAction) {
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
            } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel(CalendarCopy.moreActions)
            Button(CalendarCopy.openTask) { open() }
                .accessibilityIdentifier("calendar.task.open")
        }
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
}
