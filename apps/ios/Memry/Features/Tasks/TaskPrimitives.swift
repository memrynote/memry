import MemryCore
import SwiftUI

// TP032. The small pieces every task surface draws, after desktop's
// `task-badges.tsx` / `task-row.tsx`: the status circle, the priority mark, the
// due badge, the project chip, the repeat mark, subtask progress and a tag.
//
// Colour is never the only cue (DESIGN.md): each piece pairs its `Tokens.Task`
// colour with a symbol or text, and carries an accessibility label.

/// The status circle: open, in progress, or done.
struct TaskStatusIcon: View {
    let statusType: String?
    let isDone: Bool
    var color: Color?

    var body: some View {
        Image(systemName: symbol)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(tint)
            .accessibilityLabel(isDone ? "Done" : TasksCopy.statusTypeLabel(statusType))
    }

    private var symbol: String {
        if isDone { return "checkmark.circle.fill" }
        return statusType == "in_progress" ? "circle.lefthalf.filled" : "circle"
    }

    private var tint: Color {
        if isDone { return Tokens.Task.complete.color }
        return color ?? Tokens.Text.tertiary.color
    }
}

/// The priority mark: nothing for none, bars plus the colour otherwise.
struct TaskPriorityIcon: View {
    let priority: Int64

    var body: some View {
        if priority > 0 {
            Image(systemName: priority == 4 ? "exclamationmark.2" : "cellularbars", variableValue: Double(priority) / 3)
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Task.priority(priority).color)
                .accessibilityLabel("Priority: \(TasksCopy.priorityLabel(priority))")
        }
    }
}

/// How a due date reads, and its urgency (`formatDueDate`).
struct TaskDueLabel: Equatable {
    enum Tone: Equatable { case overdue, today, tomorrow, upcoming, later, done }

    let text: String
    let tone: Tone

    /// - Parameters:
    ///   - date: the stored `YYYY-MM-DD` (or timestamp) due date.
    ///   - time: `HH:MM`, shown when present.
    ///   - today: the user's `YYYY-MM-DD`.
    static func make(date: String, time: String?, today: String, isDone: Bool) -> TaskDueLabel? {
        guard let due = TaskDates.date(date), let now = TaskDates.date(today) else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        let days = calendar.dateComponents([.day], from: now, to: due).day ?? 0
        var text: String
        let tone: Tone
        switch days {
        case ..<(-1):
            text = due.formatted(.dateTime.month(.abbreviated).day())
            tone = .overdue
        case -1:
            text = "Yesterday"
            tone = .overdue
        case 0:
            text = "Today"
            tone = .today
        case 1:
            text = "Tomorrow"
            tone = .tomorrow
        case 2...6:
            text = due.formatted(.dateTime.weekday(.wide))
            tone = .upcoming
        default:
            let sameYear = calendar.component(.year, from: due) == calendar.component(.year, from: now)
            text = sameYear
                ? due.formatted(.dateTime.month(.abbreviated).day())
                : due.formatted(.dateTime.month(.abbreviated).day().year())
            tone = .later
        }
        if let time, let pretty = prettyTime(time) {
            text += " \(pretty)"
        }
        return TaskDueLabel(text: text, tone: isDone ? .done : tone)
    }

    /// `14:30` as the user's clock shows it.
    static func prettyTime(_ time: String) -> String? {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        var components = DateComponents()
        components.hour = parts[0]
        components.minute = parts[1]
        guard let date = Calendar(identifier: .gregorian).date(from: components) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }

    var color: Color {
        switch tone {
        case .overdue: Tokens.Task.dueOverdue.color
        case .today: Tokens.Task.dueToday.color
        case .tomorrow: Tokens.Task.dueTomorrow.color
        case .upcoming: Tokens.Task.dueUpcoming.color
        case .later, .done: Tokens.Text.secondary.color
        }
    }
}

/// The due badge: calendar symbol plus the relative day.
struct TaskDueBadge: View {
    let label: TaskDueLabel

    var body: some View {
        Label(label.text, systemImage: label.tone == .overdue ? "calendar.badge.exclamationmark" : "calendar")
            .labelStyle(.titleAndIcon)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(label.color)
            .accessibilityLabel(label.tone == .overdue ? "Overdue, due \(label.text)" : "Due \(label.text)")
    }
}

/// The project a task is filed under.
struct TaskProjectChip: View {
    let name: String
    let color: String?

    var body: some View {
        Chip(text: name, color: Tokens.Palette.color(color))
            .accessibilityLabel("Project: \(name)")
    }
}

/// The repeat mark, with "N of M" when the series has an end count.
struct TaskRepeatIndicator: View {
    let rule: RepeatRule?

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "repeat")
            if let rule, rule.endType == "count", let total = rule.endCount, total > 0 {
                Text("\(rule.completedCount + 1)/\(total)")
            }
        }
        .font(Tokens.Typography.caption.font)
        .foregroundStyle(Tokens.Task.repeatMark.color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Repeats")
    }
}

/// `3/5` done subtasks.
struct TaskSubtaskProgress: View {
    let done: Int
    let total: Int

    var body: some View {
        if total > 0 {
            Label("\(done)/\(total)", systemImage: done == total ? "checklist.checked" : "checklist")
                .labelStyle(.titleAndIcon)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(done == total ? Tokens.Task.complete.color : Tokens.Text.secondary.color)
                .accessibilityLabel("\(done) of \(total) subtasks done")
        }
    }
}

/// A tag, coloured by the shared tag palette.
struct TaskTagChip: View {
    let tag: String
    var color: String?

    var body: some View {
        Chip(text: "#\(tag)", color: Tokens.Palette.color(color, tag: tag))
            .accessibilityLabel("Tag \(tag)")
    }
}

extension TasksStore {
    /// A task's project, if this vault holds it.
    func project(_ id: String?) -> ProjectItem? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    /// The live subtasks of a task, in position order.
    func subtasks(of parentId: String) -> [TaskItem] {
        ordered.filter { $0.parentId == parentId && $0.archivedAt == nil }
    }

    /// The due label for a task, relative to today.
    func dueLabel(_ task: TaskItem) -> TaskDueLabel? {
        guard let due = task.dueDate else { return nil }
        return TaskDueLabel.make(date: due, time: task.dueTime, today: today(), isDone: task.isDone)
    }
}
