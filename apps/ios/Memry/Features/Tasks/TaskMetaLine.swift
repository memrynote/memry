import MemryCore
import SwiftUI

// RD01p. A row's one meta line (Paper artboard 01, rule 4 of artboard 00):
// date, repeat, subtasks, note, project, in that order. Tags never show in a
// row (they live on the detail), priority sits in the row's own trailing
// slot, and a row never repeats what the screen already says: no day inside
// a Today or Tomorrow group, no project inside a project scope or under a
// parent, and never the Inbox.
//
// ``TaskMeta`` is the decision, kept off the view so a test can read it.

/// What a row's meta line holds.
struct TaskMeta: Equatable {
    enum Item: Equatable {
        case due(text: String, tone: TaskDueLabel.Tone)
        case repeats(progress: String?)
        case subtasks(done: Int, total: Int)
        case notes(Int)
        case project(name: String, color: String?)

        /// One of each kind per line, so the kind is a stable identity.
        var key: String {
            switch self {
            case .due: "due"
            case .repeats: "repeats"
            case .subtasks: "subtasks"
            case .notes: "notes"
            case .project: "project"
            }
        }
    }

    let items: [Item]

    var isEmpty: Bool { items.isEmpty }

    /// Where the row sits, so it can leave out what the screen already says.
    struct Context: Equatable {
        /// The section or view names the day (Today, Tomorrow).
        var omitsDay = false
        /// The row may name its project (not in a project scope, not a subtask).
        var showsProject = true
    }

    // swiftlint:disable:next function_parameter_count
    static func make(
        due: TaskDueLabel?,
        rule: RepeatRule?,
        isRepeating: Bool,
        subtasks: (done: Int, total: Int),
        notes: Int,
        project: ProjectItem?,
        context: Context
    ) -> TaskMeta {
        var items: [Item] = []
        // An overdue date is always news, even inside a view about today.
        if let due, let text = due.text(omittingDay: context.omitsDay && due.tone != .overdue) {
            items.append(.due(text: text, tone: due.tone))
        }
        if rule != nil || isRepeating {
            items.append(.repeats(progress: TaskRepeatProgress.text(rule)))
        }
        if subtasks.total > 0 {
            items.append(.subtasks(done: subtasks.done, total: subtasks.total))
        }
        if notes > 0 {
            items.append(.notes(notes))
        }
        if context.showsProject, let project, !project.isInbox {
            items.append(.project(name: project.name, color: project.color))
        }
        return TaskMeta(items: items)
    }
}

extension TasksStore {
    /// The meta line of a task in a given place.
    func meta(_ task: TaskItem, context: TaskMeta.Context) -> TaskMeta {
        TaskMeta.make(
            due: dueLabel(task),
            rule: task.repeat,
            isRepeating: task.isRepeating,
            subtasks: rowSubtaskCounts(task),
            notes: rowLinkedNoteCount(task),
            project: project(task.projectId),
            context: context
        )
    }
}

/// The meta line: footnote-sized, tertiary ink, the date in its urgency
/// colour. It wraps rather than truncates at large text sizes.
struct TaskMetaLine: View {
    let meta: TaskMeta

    var body: some View {
        if !meta.isEmpty {
            TaskFlowLayout(horizontal: Tokens.Space.small, vertical: Tokens.Space.tight) {
                ForEach(meta.items, id: \.key) { item in
                    view(item)
                }
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
        }
    }

    @ViewBuilder private func view(_ item: TaskMeta.Item) -> some View {
        switch item {
        case let .due(text, tone):
            let label = TaskDueLabel(text: text, tone: tone, day: text, time: nil)
            Text(text)
                .foregroundStyle(label.color)
                .accessibilityLabel(TasksCopy.rowDue(label))
        case let .repeats(progress):
            HStack(spacing: Tokens.Space.tight) {
                Image(systemName: "repeat")
                if let progress { Text(progress).monospacedDigit() }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(TasksCopy.rowRepeats)
        case let .subtasks(done, total):
            TaskSubtaskProgress(done: done, total: total)
        case let .notes(count):
            HStack(spacing: Tokens.Space.tight) {
                Image(systemName: "doc.text")
                if count > 1 { Text(count.formatted()) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(TasksCopy.rowLinkedNotes(count))
        case let .project(name, color):
            TaskProjectChip(name: name, color: color)
        }
    }
}

/// Lines that wrap, with their own horizontal and vertical gaps (pills keep
/// a 44pt hit frame, so their rows need no extra vertical gap).
struct TaskFlowLayout: Layout {
    var horizontal: CGFloat
    var vertical: CGFloat
    var alignment: VerticalAlignment = .center

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let height = rows.last.map { $0.top + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: min(proposal.width ?? width, width), height: height)
    }

    /// SwiftUI mirrors a custom layout's placements in right-to-left, so
    /// this places toward the trailing edge in leading-to-trailing terms.
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(bounds.width, subviews) {
            var offset: CGFloat = 0
            for index in row.items {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(
                    at: CGPoint(x: bounds.minX + offset, y: bounds.minY + row.top + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                offset += size.width + horizontal
            }
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
        var top: CGFloat = 0
    }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            var row = rows[rows.count - 1]
            let needed = row.items.isEmpty ? size.width : row.width + horizontal + size.width
            if needed > maxWidth, !row.items.isEmpty {
                let top = row.top + row.height + vertical
                rows.append(Row(items: [index], width: size.width, height: size.height, top: top))
                continue
            }
            row.items.append(index)
            row.width = needed
            row.height = max(row.height, size.height)
            rows[rows.count - 1] = row
        }
        return rows
    }
}
