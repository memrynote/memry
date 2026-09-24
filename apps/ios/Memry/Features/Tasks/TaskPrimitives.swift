import MemryCore
import SwiftUI

// TP032, redesigned (RD01p). The small pieces every task surface draws, after
// the Paper redesign (artboards 01, 08): the status mark, the priority bars,
// the due label, the progress ring and a tag.
//
// Everything is an SF Symbol or sized from one, so it scales with Dynamic
// Type without a point size in this file. Colour is never the only cue
// (DESIGN.md): the status mark changes shape, the bars change count, and each
// piece carries an accessibility label.

/// The redesign's row geometry, as token sums (Paper artboard 01).
enum TaskLayout {
    /// The screen edge rows and headers sit on (Paper 20pt).
    static let edge = Tokens.Space.inset + Tokens.Space.tight
    /// The status lane (Paper 24pt), so status, title and priority line up.
    static let lane = Tokens.Space.section
    /// A row's vertical padding (Paper 11pt).
    static let rowPadding = Tokens.Space.medium
}

/// A status mark in its lane: a hidden line of body text sets the lane's
/// height and baseline, so the mark sits on the title's first line at any
/// Dynamic Type size, and the 44pt button overflows the lane without
/// widening it.
struct TaskStatusLane<Mark: View>: View {
    let action: () -> Void
    let label: String
    let identifier: String
    @ViewBuilder let mark: () -> Mark
    /// The lane grows with Dynamic Type so the mark (a body-sized symbol)
    /// never spills past the screen edge at accessibility sizes.
    @ScaledMetric(relativeTo: .body) private var lane = TaskLayout.lane

    var body: some View {
        Text(verbatim: "A")
            .font(Tokens.Typography.body.font)
            .hidden()
            .frame(width: lane)
            .overlay {
                Button(action: action) {
                    mark()
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
            }
    }
}

/// Which glyph a status reads as: a dashed ring for to do, a half-filled
/// circle for in progress, a filled check for done.
enum TaskStatusGlyph {
    static func symbol(statusType: String?, isDone: Bool) -> String {
        if isDone { return "checkmark.circle.fill" }
        return statusType == "in_progress" ? "circle.lefthalf.filled" : "circle.dashed"
    }
}

/// The status mark: dashed ring, half circle or filled check, in the status's
/// colour (done in the completion colour, to do in the tertiary ink).
struct TaskStatusIcon: View {
    let statusType: String?
    let isDone: Bool
    var color: Color?
    var scale: Image.Scale = .large

    var body: some View {
        Image(systemName: TaskStatusGlyph.symbol(statusType: statusType, isDone: isDone))
            .font(Tokens.Typography.body.font)
            .imageScale(scale)
            .foregroundStyle(tint)
            .accessibilityLabel(isDone ? TasksCopy.statusTypeLabel("done") : TasksCopy.statusTypeLabel(statusType))
    }

    private var tint: Color {
        if isDone { return Tokens.Task.complete.color }
        if statusType == "in_progress" { return color ?? Tokens.Task.dueToday.color }
        return Tokens.Text.tertiary.color
    }
}

/// The priority bars: nothing for none, one to four bars in the priority's
/// colour (low one, urgent all four), the rest drawn quiet.
struct TaskPriorityIcon: View {
    let priority: Int64
    var font: Font = Tokens.Typography.caption.font

    var body: some View {
        if priority > 0 {
            Image(systemName: "cellularbars", variableValue: TaskPriorityBars.fill(priority))
                .font(font.weight(.semibold))
                .foregroundStyle(Tokens.Task.priority(priority).color)
                .accessibilityLabel(TasksCopy.rowPriority(priority))
        }
    }
}

/// How full the bars are for a priority: 0 none .. 4 urgent, a quarter each.
enum TaskPriorityBars {
    static func fill(_ priority: Int64) -> Double {
        Double(min(max(priority, 0), 4)) / 4
    }
}

/// How a due date reads, and its urgency (`formatDueDate`).
struct TaskDueLabel: Equatable {
    enum Tone: Equatable { case overdue, today, tomorrow, upcoming, later, done }

    /// The day and the time, e.g. "Tomorrow 10:00".
    let text: String
    let tone: Tone
    /// The day alone ("Today", "Sep 20").
    let day: String
    /// The time alone, when the task has one.
    let time: String?

    /// - Parameters:
    ///   - date: the stored `YYYY-MM-DD` (or timestamp) due date.
    ///   - time: `HH:MM`, shown when present.
    ///   - today: the user's `YYYY-MM-DD`.
    static func make(date: String, time: String?, today: String, isDone: Bool) -> TaskDueLabel? {
        guard let due = TaskDates.date(date), let now = TaskDates.date(today) else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        let days = calendar.dateComponents([.day], from: now, to: due).day ?? 0
        let day: String
        let tone: Tone
        switch days {
        case ..<(-1):
            day = due.formatted(.dateTime.month(.abbreviated).day())
            tone = .overdue
        case -1:
            day = TasksCopy.dueYesterday
            tone = .overdue
        case 0:
            day = TasksCopy.rowToday
            tone = .today
        case 1:
            day = TasksCopy.rowTomorrow
            tone = .tomorrow
        case 2 ... 6:
            day = due.formatted(.dateTime.weekday(.wide))
            tone = .upcoming
        default:
            let sameYear = calendar.component(.year, from: due) == calendar.component(.year, from: now)
            day = sameYear
                ? due.formatted(.dateTime.month(.abbreviated).day())
                : due.formatted(.dateTime.month(.abbreviated).day().year())
            tone = .later
        }
        let pretty = time.flatMap(prettyTime)
        let text = pretty.map { "\(day) \($0)" } ?? day
        return TaskDueLabel(text: text, tone: isDone ? .done : tone, day: day, time: pretty)
    }

    /// What a row shows when the screen already names the day (a Today or
    /// Tomorrow group, or the Today and Tomorrow views): the time, or nothing.
    func text(omittingDay: Bool) -> String? {
        omittingDay ? time : text
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
        case .later, .done: Tokens.Text.tertiary.color
        }
    }
}

/// The due badge: the relative day in its urgency colour (subtask rows).
struct TaskDueBadge: View {
    let label: TaskDueLabel

    var body: some View {
        Text(label.text)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(label.color)
            .accessibilityLabel(TasksCopy.rowDue(label))
    }
}

/// A ring filled to `fraction`, the size of an SF Symbol at `font`, so it
/// scales with Dynamic Type like the text beside it.
struct TaskProgressRing: View {
    let fraction: Double
    var color: Color = Tokens.Text.tertiary.color
    var font: Font = Tokens.Typography.caption.font

    var body: some View {
        Image(systemName: "circle")
            .font(font)
            .hidden()
            .overlay {
                GeometryReader { proxy in
                    let width = max(proxy.size.width / 7, Tokens.Size.hairline)
                    ZStack {
                        Circle().stroke(Tokens.Line.border.color, lineWidth: width)
                        Circle()
                            .trim(from: 0, to: min(max(fraction, 0), 1))
                            .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    .padding(width / 2)
                }
            }
            .accessibilityHidden(true)
    }
}

/// A project's colour dot, sized from a symbol.
struct TaskProjectDot: View {
    let color: String?
    var font: Font = Tokens.Typography.caption.font

    var body: some View {
        Image(systemName: "circle.fill")
            .font(font)
            .imageScale(.small)
            .foregroundStyle(Tokens.Palette.color(color))
            .accessibilityHidden(true)
    }
}

/// The project a task is filed under: its dot and name.
struct TaskProjectChip: View {
    let name: String
    let color: String?

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            TaskProjectDot(color: color)
            Text(name)
        }
        .font(Tokens.Typography.caption.font)
        .foregroundStyle(Tokens.Text.tertiary.color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TasksCopy.rowProject(name))
    }
}

/// The repeat mark, with "N/M" when the series has an end count.
struct TaskRepeatIndicator: View {
    let rule: RepeatRule?

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            Image(systemName: "repeat")
            if let progress = TaskRepeatProgress.text(rule) {
                Text(progress).monospacedDigit()
            }
        }
        .font(Tokens.Typography.caption.font)
        .foregroundStyle(Tokens.Text.tertiary.color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TasksCopy.rowRepeats)
    }
}

/// "3/10" for a series that ends after a count; nothing otherwise.
enum TaskRepeatProgress {
    static func text(_ rule: RepeatRule?) -> String? {
        guard let rule, rule.endType == "count", let total = rule.endCount, total > 0 else { return nil }
        return "\(rule.completedCount + 1)/\(total)"
    }
}

/// `2/5` done subtasks, with a ring.
struct TaskSubtaskProgress: View {
    let done: Int
    let total: Int

    var body: some View {
        if total > 0 {
            HStack(spacing: Tokens.Space.tight) {
                TaskProgressRing(
                    fraction: Double(done) / Double(total),
                    color: done == total ? Tokens.Task.complete.color : Tokens.Text.secondary.color
                )
                Text("\(done)/\(total)").monospacedDigit()
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(TasksCopy.rowSubtasks(done: done, total: total))
        }
    }
}

/// A tag, coloured by the shared tag palette.
struct TaskTagChip: View {
    let tag: String
    var color: String?

    var body: some View {
        Chip(text: "#\(tag)", color: Tokens.Palette.color(color, tag: tag))
            .accessibilityLabel(TasksCopy.tagLabel(tag))
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
