import MemryCore
import SwiftUI

// TP043. The detail's property rows, after the drawer's properties grid:
// status (the project's statuses), priority, start date, due date and time,
// project and repeat. Each row is a native menu or opens its picker sheet;
// every write goes through the store's `detail*` operations.

/// The sheet a property row opened.
private enum TaskDetailSheet: String, Identifiable {
    case due, start, repeatRule

    var id: String { rawValue }
}

struct TaskDetailProperties: View {
    let task: TaskItem
    let store: TasksStore

    @State private var sheet: TaskDetailSheet?

    var body: some View {
        Section {
            statusRow
            priorityRow
            dateRow(
                label: TasksCopy.Detail.startDate,
                value: startLabel,
                identifier: "tasks.detail.startDate",
                sheet: .start
            )
            dateRow(
                label: TasksCopy.Detail.dueDate,
                value: store.dueLabel(task)?.text,
                tone: store.dueLabel(task)?.color,
                identifier: "tasks.detail.dueDate",
                sheet: .due
            )
            projectRow
            repeatRow
        }
        .sheet(item: $sheet) { sheet in
            sheetContent(sheet)
        }
    }

    // MARK: Rows

    private var statuses: [StatusItem] {
        (store.project(task.projectId)?.statuses ?? []).sorted { $0.position < $1.position }
    }

    private var currentStatus: StatusItem? {
        statuses.first { $0.id == task.statusId }
    }

    private var statusRow: some View {
        Menu {
            ForEach(statuses, id: \.id) { status in
                Button {
                    Task { await store.detailSetStatus(task, statusId: status.id) }
                } label: {
                    if status.id == task.statusId {
                        Label(status.name, systemImage: "checkmark")
                    } else {
                        Text(status.name)
                    }
                }
            }
        } label: {
            TaskDetailRow(label: TasksCopy.Detail.status) {
                HStack(spacing: Tokens.Space.small) {
                    TaskStatusIcon(
                        statusType: currentStatus?.statusType ?? task.statusType,
                        isDone: task.isDone,
                        color: currentStatus.map { Tokens.Palette.color($0.color) }
                    )
                    .accessibilityHidden(true)
                    Text(currentStatus?.name ?? TasksCopy.statusTypeLabel(task.statusType))
                }
            }
        }
        .disabled(statuses.isEmpty)
        .accessibilityIdentifier("tasks.detail.status")
    }

    private var priorityRow: some View {
        Menu {
            ForEach([Int64(4), 3, 2, 1, 0], id: \.self) { priority in
                Button {
                    Task { await store.detailSetPriority(task, priority) }
                } label: {
                    if priority == task.priority {
                        Label(TasksCopy.priorityLabel(priority), systemImage: "checkmark")
                    } else {
                        Text(TasksCopy.priorityLabel(priority))
                    }
                }
            }
        } label: {
            TaskDetailRow(label: TasksCopy.Detail.priority) {
                HStack(spacing: Tokens.Space.small) {
                    TaskPriorityIcon(priority: task.priority)
                        .accessibilityHidden(true)
                    Text(TasksCopy.priorityLabel(task.priority))
                }
            }
        }
        .accessibilityIdentifier("tasks.detail.priority")
    }

    private var startLabel: String? {
        guard let start = task.startDate else { return nil }
        return TaskDueLabel.make(date: start, time: nil, today: store.today(), isDone: task.isDone)?.text
    }

    private func dateRow(
        label: String,
        value: String?,
        tone: Color? = nil,
        identifier: String,
        sheet: TaskDetailSheet
    ) -> some View {
        Button {
            self.sheet = sheet
        } label: {
            TaskDetailRow(label: label) {
                Text(value ?? TasksCopy.Detail.noDate)
                    .foregroundStyle(value == nil ? Tokens.Text.tertiary.color : (tone ?? Tokens.Text.primary.color))
            }
        }
        .accessibilityIdentifier(identifier)
    }

    private var liveProjects: [ProjectItem] {
        store.projects
            .filter { $0.archivedAt == nil || $0.id == task.projectId }
            .sorted { $0.position < $1.position }
    }

    private var projectRow: some View {
        Menu {
            ForEach(liveProjects, id: \.id) { project in
                Button {
                    Task { await store.detailMove(task, toProject: project.id) }
                } label: {
                    if project.id == task.projectId {
                        Label(project.name, systemImage: "checkmark")
                    } else {
                        Text(project.name)
                    }
                }
            }
        } label: {
            TaskDetailRow(label: TasksCopy.Detail.project) {
                if let project = store.project(task.projectId) {
                    TaskProjectChip(name: project.name, color: project.color)
                } else {
                    Text(TasksCopy.Detail.project).foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
        }
        .accessibilityIdentifier("tasks.detail.project")
    }

    private var repeatRow: some View {
        Button {
            sheet = .repeatRule
        } label: {
            TaskDetailRow(label: TasksCopy.Detail.repeatLabel) {
                VStack(alignment: .trailing, spacing: Tokens.Space.tight) {
                    HStack(spacing: Tokens.Space.small) {
                        if task.isRepeating {
                            TaskRepeatIndicator(rule: task.repeat).accessibilityHidden(true)
                        }
                        Text(TaskRepeatText.summary(task))
                            .foregroundStyle(
                                task.isRepeating ? Tokens.Text.primary.color : Tokens.Text.tertiary.color
                            )
                    }
                    if let info = TaskRepeatText.info(task.repeat) {
                        Text(info)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
            }
        }
        .accessibilityIdentifier("tasks.detail.repeat")
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetContent(_ sheet: TaskDetailSheet) -> some View {
        switch sheet {
        case .due:
            TaskDateSheet(
                title: TasksCopy.Detail.dueDate,
                date: task.dueDate,
                time: task.dueTime,
                allowsTime: true,
                store: store
            ) { date, time in
                Task { await store.detailSetDue(task, date: date, time: time) }
            }
        case .start:
            TaskDateSheet(
                title: TasksCopy.Detail.startDate,
                date: task.startDate,
                time: nil,
                allowsTime: false,
                store: store
            ) { date, _ in
                Task { await store.detailSetStartDate(task, date: date) }
            }
        case .repeatRule:
            RepeatSheet(
                taskId: task.id,
                rule: task.repeat,
                repeatFrom: task.repeatFrom,
                anchorDate: task.dueDate,
                store: store
            ) { rule, repeatFrom in
                Task { await store.detailSetRepeat(task, rule: rule, repeatFrom: repeatFrom) }
            }
        }
    }
}

/// One property row: the label leading, the value trailing, the whole row a
/// 44pt target read as "label, value". At accessibility text sizes the value
/// goes under the label, so neither is broken mid-word.
struct TaskDetailRow<Value: View>: View {
    let label: String
    @ViewBuilder let value: () -> Value

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Tokens.Space.tight))
            : AnyLayout(HStackLayout(spacing: Tokens.Space.medium))
        layout {
            Text(label)
                .foregroundStyle(Tokens.Text.secondary.color)
            if !stacked { Spacer(minLength: Tokens.Space.small) }
            value()
                .foregroundStyle(Tokens.Text.primary.color)
                .multilineTextAlignment(stacked ? .leading : .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .font(Tokens.Typography.body.font)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// How a task's repeat reads in the row (desktop `TaskRepeatSection`'s title
/// and info line), from the stored rule's fields only.
enum TaskRepeatText {
    static func summary(_ task: TaskItem) -> String {
        guard task.isRepeating else { return TasksCopy.Detail.noRepeat }
        guard let rule = task.repeat else { return TasksCopy.Detail.repeatsUnreadable }
        return TasksCopy.Detail.repeatSummary(frequency: rule.frequency, interval: rule.interval)
    }

    /// `Ends: … | Done: Nx`, or `nil` without a readable rule.
    static func info(_ rule: RepeatRule?) -> String? {
        guard let rule else { return nil }
        var parts: [String] = []
        switch rule.endType {
        case "date":
            if let end = rule.endDate, let date = TaskDates.date(end) {
                parts.append(TasksCopy.Detail.repeatEndsOn(date.formatted(.dateTime.month(.abbreviated).day())))
            }
        case "count":
            if let count = rule.endCount { parts.append(TasksCopy.Detail.repeatEndsAfter(count)) }
        default:
            parts.append(TasksCopy.Detail.repeatEndsNever)
        }
        parts.append(TasksCopy.Detail.repeatDoneCount(rule.completedCount))
        return parts.joined(separator: " | ")
    }
}
