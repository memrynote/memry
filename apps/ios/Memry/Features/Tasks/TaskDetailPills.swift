import MemryCore
import SwiftUI

// RD08 / RD09. The detail's properties, one labelled row each, after
// desktop's task detail drawer: Status, Priority, Start date, Due date (When,
// with repeat and bell marks inside it), Reminder, Project, Parent task,
// Tags, Linked. A set value is a pill, an unset one a quiet "Empty". Each
// value is a native menu or opens a sheet: a property is one tap to open and
// one to choose; the When sheet is the one deeper level.

struct TaskDetailPills: View {
    let task: TaskItem
    let store: TasksStore

    @Environment(TasksRouter.self) private var router: TasksRouter?
    @State private var sheet: Sheet?
    @State private var reminderCount = 0
    @State private var reminderVersion = 0

    enum Sheet: String, Identifiable {
        case when, start, parent, related, tags, reminder

        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TaskPropertyRow(TasksCopy.fieldStatus, symbol: "circle.dashed") { statusPill }
            TaskPropertyRow(TasksCopy.fieldPriority, symbol: "cellularbars") {
                if task.priority > 0 {
                    priorityPill
                } else {
                    Menu { priorityPicker } label: { TaskPropertyEmpty() }
                        .accessibilityLabel(TasksCopy.rowPriority(0))
                        .accessibilityIdentifier("tasks.detail.priority")
                }
            }
            TaskPropertyRow(TasksCopy.fieldStartDate, symbol: "calendar.badge.clock") {
                if task.startDate != nil {
                    startPill
                } else {
                    Button { sheet = .start } label: { TaskPropertyEmpty() }
                        .buttonStyle(.plain)
                        .accessibilityLabel(TasksCopy.fieldStartDate)
                        .accessibilityIdentifier("tasks.detail.startDate")
                }
            }
            TaskPropertyRow(TasksCopy.fieldDueDate, symbol: "calendar") {
                if task.dueDate != nil || task.isRepeating {
                    whenPill
                } else {
                    Menu { TaskWhenMenu(store: store, actions: whenActions) } label: { TaskPropertyEmpty() }
                        .accessibilityLabel(TasksCopy.fieldDueDate)
                        .accessibilityIdentifier("tasks.detail.dueDate")
                }
            }
            TaskPropertyRow(TasksCopy.composerReminder, symbol: "bell") { reminderValue }
            TaskPropertyRow(TasksCopy.fieldProject, symbol: "folder") { projectPill }
            if task.parentId != nil || store.rowCanBecomeSubtask(task) {
                TaskPropertyRow(TasksCopy.fieldParent, symbol: "arrow.turn.down.right") {
                    if task.parentId != nil {
                        parentPill
                    } else {
                        Button { sheet = .parent } label: { TaskPropertyEmpty() }
                            .buttonStyle(.plain)
                            .accessibilityLabel(TasksCopy.detailParentLabel(nil))
                            .accessibilityIdentifier("tasks.detail.parent")
                    }
                }
            }
            TaskPropertyRow(TasksCopy.fieldTags, symbol: "number") {
                TaskFlowLayout(horizontal: Tokens.Space.small, vertical: 0) {
                    ForEach(task.tags, id: \.self) { tagPill($0) }
                    Button { sheet = .tags } label: {
                        if task.tags.isEmpty { TaskPropertyEmpty() } else { TaskAddPill() }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(TasksCopy.detailAddTag)
                    .accessibilityIdentifier("tasks.detail.addTag")
                }
            }
            TaskPropertyRow(TasksCopy.detailLinked, symbol: "link") {
                Button { sheet = .related } label: { TaskPropertyEmpty(text: TasksCopy.detailLinkItem) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("tasks.detail.link")
            }
        }
        .accessibilityElement(children: .contain)
        .task(id: ReminderKey(task: task, version: reminderVersion)) {
            reminderCount = await store.activeReminders(of: task.id).count
        }
        .sheet(item: $sheet, onDismiss: { reminderVersion += 1 }) { sheet in content(sheet) }
    }

    // MARK: Pills

    private var statuses: [StatusItem] {
        (store.project(task.projectId)?.statuses ?? []).sorted { $0.position < $1.position }
    }

    private var statusPill: some View {
        let status = store.rowStatus(task)
        return Menu {
            Picker(TasksCopy.fieldStatus, selection: Binding(
                get: { task.statusId },
                set: { id in if let id { Task { await store.detailSetStatus(task, statusId: id) } } }
            )) {
                ForEach(statuses, id: \.id) { item in
                    Label(item.name, systemImage: TaskStatusGlyph.symbol(statusType: item.statusType, isDone: item.isDone))
                        .tag(Optional(item.id))
                }
            }
            .pickerStyle(.inline)
        } label: {
            TaskPillLabel(text: status?.name ?? TasksCopy.statusTypeLabel(task.statusType)) {
                TaskStatusIcon(
                    statusType: task.statusType, isDone: task.isDone,
                    color: status.map { Tokens.Palette.color($0.color) }, scale: .small
                )
                .font(Tokens.Typography.caption.font)
            }
        }
        .disabled(statuses.isEmpty)
        .accessibilityLabel("\(TasksCopy.fieldStatus): \(status?.name ?? TasksCopy.statusTypeLabel(task.statusType))")
        .accessibilityIdentifier("tasks.detail.status")
    }

    private var priorityPicker: some View {
        Picker(TasksCopy.fieldPriority, selection: Binding(
            get: { task.priority },
            set: { value in Task { await store.detailSetPriority(task, value) } }
        )) {
            ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { (value: Int64) in
                Text(TasksCopy.priorityLabel(value)).tag(value)
            }
        }
        .pickerStyle(.inline)
    }

    private var priorityPill: some View {
        Menu { priorityPicker } label: {
            TaskPillLabel(text: TasksCopy.priorityLabel(task.priority)) {
                TaskPriorityIcon(priority: task.priority)
            }
        }
        .accessibilityLabel(TasksCopy.rowPriority(task.priority))
        .accessibilityIdentifier("tasks.detail.priority")
    }

    private var whenPill: some View {
        let due = store.dueLabel(task)
        var marks: [String] = []
        if task.isRepeating { marks.append("repeat") }
        if reminderCount > 0 { marks.append("bell") }
        return Menu {
            TaskWhenMenu(store: store, actions: whenActions)
        } label: {
            TaskPillLabel(
                text: due?.text ?? TasksCopy.repeats,
                tone: due.map { .inked(TaskComposerChips.dueColor($0.tone)) } ?? .neutral,
                trailingSymbols: marks
            ) {
                TaskPillSymbol(name: "calendar", color: due?.color)
            }
        }
        .accessibilityLabel(TasksCopy.detailWhenLabel(due?.text, repeats: task.isRepeating, reminders: reminderCount))
        .accessibilityIdentifier("tasks.detail.dueDate")
    }

    private var whenActions: TaskWhenActions {
        let task = task
        return TaskWhenActions(
            date: task.dueDate,
            rule: task.repeat,
            reminderCount: reminderCount,
            setDate: { date in Task { await store.detailRequestDue(task, date: date, time: task.dueTime) } },
            removeDate: { Task { await store.detailRequestDue(task, date: nil, time: nil) } },
            pickDateTime: { sheet = .when },
            setRule: { rule in Task { await store.detailRequestRule(task, rule: rule) } },
            addReminder: { date in
                Task {
                    await store.addReminder(to: task.id, at: date, note: nil)
                    reminderVersion += 1
                }
            }
        )
    }

    private var projectPill: some View {
        let project = store.project(task.projectId)
        return Menu {
            Picker(TasksCopy.fieldProject, selection: Binding(
                get: { task.projectId },
                set: { id in Task { await store.detailMove(task, toProject: id) } }
            )) {
                ForEach(store.projects.filter { $0.archivedAt == nil || $0.id == task.projectId }, id: \.id) { item in
                    Text(item.name).tag(item.id)
                }
            }
            .pickerStyle(.inline)
        } label: {
            TaskPillLabel(text: project?.name ?? TasksCopy.composerNoProject) {
                TaskProjectDot(color: project?.color, font: Tokens.Typography.supporting.font)
            }
        }
        .accessibilityLabel(TasksCopy.rowProject(project?.name ?? TasksCopy.composerNoProject))
        .accessibilityIdentifier("tasks.detail.project")
    }

    private var startPill: some View {
        let text = task.startDate.flatMap {
            TaskDueLabel.make(date: $0, time: nil, today: store.today(), isDone: false)?.text
        } ?? ""
        return Menu {
            Button(TasksCopy.detailChangeStart, systemImage: "calendar") { sheet = .start }
            Button(TasksCopy.whenRemoveStart, systemImage: "calendar.badge.minus", role: .destructive) {
                Task { await store.detailRequestStart(task, date: nil) }
            }
        } label: {
            TaskPillLabel(text: TasksCopy.detailStarts(text)) { TaskPillSymbol(name: "calendar.badge.clock") }
        }
        .accessibilityIdentifier("tasks.detail.startDate")
    }

    private var parentPill: some View {
        let parent = task.parentId.flatMap { store.items[$0] }
        return Menu {
            if let parent {
                Button(TasksCopy.detailOpenParent, systemImage: "arrow.up.forward") { router?.open(.task(parent.id)) }
            }
            Button(TasksCopy.detailChangeParent, systemImage: "arrow.turn.down.right") { sheet = .parent }
            Button(TasksCopy.subtaskPromote, systemImage: "arrow.up.backward") {
                Task { await store.promoteToTask(task) }
            }
        } label: {
            TaskPillLabel(text: parent?.title ?? TasksCopy.fieldParent) { TaskPillSymbol(name: "arrow.turn.down.right") }
        }
        .accessibilityLabel(TasksCopy.detailParentLabel(parent?.title))
        .accessibilityIdentifier("tasks.detail.parent")
    }

    private func tagPill(_ tag: String) -> some View {
        Menu {
            Button(TasksCopy.Detail.removeTag(tag), systemImage: "xmark", role: .destructive) {
                Task { await store.detailRemoveTag(store.items[task.id] ?? task, tag) }
            }
        } label: {
            TaskPillLabel(text: "#\(tag)", tone: .tinted(Tokens.Task.tokenTag))
        }
        .accessibilityLabel(TasksCopy.tagLabel(tag))
        .accessibilityIdentifier("tasks.detail.tag.\(tag)")
    }

    /// The active reminders' count, or Empty; either opens Add reminder.
    private var reminderValue: some View {
        Button { sheet = .reminder } label: {
            if reminderCount > 0 {
                TaskPillLabel(text: TasksCopy.whenReminderCount(reminderCount)) { TaskPillSymbol(name: "bell") }
            } else {
                TaskPropertyEmpty()
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(TasksCopy.composerReminder): \(TasksCopy.whenReminderCount(reminderCount))")
        .accessibilityIdentifier("tasks.detail.reminder")
    }

    // MARK: Sheets

    @ViewBuilder private func content(_ sheet: Sheet) -> some View {
        let current = store.items[task.id] ?? task
        switch sheet {
        case .when:
            TaskWhenSheet(store: store, target: .task(current))
        case .start:
            TaskDateSheet(
                title: TasksCopy.fieldStartDate, date: current.startDate, time: nil, allowsTime: false, store: store
            ) { date, _ in
                Task { await store.detailRequestStart(current, date: date) }
            }
        case .parent:
            ParentPickerSheet(task: current, store: store)
        case .related:
            TaskRelatedPicker(task: current, store: store)
        case .tags:
            NavigationStack {
                Form { TaskDetailTags(task: current, store: store) }
                    .navigationTitle(TasksCopy.Detail.tags)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            SheetConfirmButton(label: TasksCopy.Detail.done) { self.sheet = nil }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        case .reminder:
            TaskReminderPickerSheet(mode: .add, now: store.clock()) { date, note in
                self.sheet = nil
                Task { await store.addReminder(to: current.id, at: date, note: note) }
            }
        }
    }

    private struct ReminderKey: Hashable {
        let task: TaskItem
        let version: Int
    }
}

extension TasksStore {
    /// A due date from the detail: a repeating task asks Edit Repeating first.
    func detailRequestDue(_ task: TaskItem, date: String?, time: String?) async {
        if isRepeating(task.id) {
            await requestRepeatingEdit(taskId: task.id, .due(date: date, time: date == nil ? nil : time))
        } else {
            await detailSetDue(task, date: date, time: date == nil ? nil : time)
        }
    }

    /// A start date from the detail: a repeating task asks Edit Repeating first.
    func detailRequestStart(_ task: TaskItem, date: String?) async {
        if isRepeating(task.id) {
            await requestRepeatingEdit(taskId: task.id, .start(date: date))
        } else {
            await detailSetStartDate(task, date: date)
        }
    }

    /// A preset rule from the When menu: a new rule is written; a change to a
    /// series asks Edit Repeating, and "Never" on a series asks Stop Repeating.
    func detailRequestRule(_ task: TaskItem, rule: RepeatRule?) async {
        guard isRepeating(task.id) else {
            if let rule { await detailSetRepeat(task, rule: rule, repeatFrom: nil) }
            return
        }
        guard let rule else {
            prompt = .stopRepeating(taskId: task.id)
            return
        }
        await requestRepeatingEdit(taskId: task.id, .rule(rule, repeatFrom: task.repeatFrom))
    }
}

extension TasksCopy {
    static let detailEmpty = "Empty"
    static let detailLinked = "Linked"
    static let detailAddTag = "Tag"
    static let detailLinkItem = "Link note or file"
    static let detailChangeStart = "Change start date"
    static let detailOpenParent = "Open parent task"
    static let detailChangeParent = "Change parent task"

    static func detailStarts(_ day: String) -> String { "Starts \(day)" }

    static func detailParentLabel(_ title: String?) -> String { "Parent task: \(title ?? "none")" }

    static func detailWhenLabel(_ due: String?, repeats: Bool, reminders: Int) -> String {
        var parts = [due.map { "Due \($0)" } ?? rowRepeats]
        if repeats, due != nil { parts.append(rowRepeats) }
        if reminders > 0 { parts.append(whenReminderCount(reminders)) }
        return parts.joined(separator: ", ")
    }
}

/// One property row (desktop's `PropertyRow`): a fixed-width label column
/// with its glyph, then the value.
struct TaskPropertyRow<Value: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var value: () -> Value

    /// Grows with Dynamic Type so long labels keep one column.
    @ScaledMetric(relativeTo: .subheadline) private var labelWidth: CGFloat = 112

    init(_ title: String, symbol: String, @ViewBuilder value: @escaping () -> Value) {
        self.title = title
        self.symbol = symbol
        self.value = value
    }

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.small) {
            Label {
                Text(title).lineLimit(2)
            } icon: {
                Image(systemName: symbol).foregroundStyle(Tokens.Text.tertiary.color)
            }
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(width: labelWidth, alignment: .leading)
            .accessibilityHidden(true)
            value()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
    }
}

/// An unset property's value: quiet text where the pill would sit.
struct TaskPropertyEmpty: View {
    var text = TasksCopy.detailEmpty

    var body: some View {
        Text(text)
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .lineLimit(1)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
    }
}
