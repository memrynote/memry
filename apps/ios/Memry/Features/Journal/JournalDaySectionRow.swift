import MemryCore
import SwiftUI

// JP050. One task in the Day section (Paper J01, J10): the Tasks row's own
// pieces (status lane, title, meta line with the project, priority bars),
// laid out as `TaskRowView` lays them out. Not `TaskRowView` itself: its tap
// pushes `TasksRoute` onto the Tasks stack, which the Journal stack does not
// register; this row opens the task in the Tasks tab instead.

struct JournalDayTaskRow: View {
    let task: TaskItem
    let tasks: TasksStore
    /// The last row draws no separator under it (J01).
    var isLast = false

    @Environment(TasksRouter.self) private var router: TasksRouter?
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Bumped on each completion, driving the success haptic.
    @State private var completions = 0

    /// The header names the day, so the meta line keeps only the time, or
    /// the date when it is overdue (`TaskMeta.Context.omitsDay`).
    private static let context = TaskMeta.Context(omitsDay: true, showsProject: true)

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            TaskStatusLane(
                action: toggleComplete,
                label: task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete,
                identifier: "journal.day.task.status"
            ) {
                TaskStatusIcon(
                    statusType: task.statusType,
                    isDone: task.isDone,
                    color: tasks.rowStatus(task).map { Tokens.Palette.color($0.color) }
                )
            }
            Button(action: open) { content }
                .buttonStyle(.plain)
        }
        .padding(.leading, TaskLayout.edge)
        .sensoryFeedback(.success, trigger: completions)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tasks.rowAccessibilityLabel(task))
        .accessibilityHint(TasksCopy.openInTasks)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { open() }
        .accessibilityAction(named: task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete) {
            toggleComplete()
        }
        .accessibilityIdentifier("journal.day.task.\(task.id)")
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(task.title)
                    .font(Tokens.Typography.body.font)
                    .strikethrough(task.isDone)
                    .foregroundStyle(task.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                    .multilineTextAlignment(.leading)
                    .lineLimit(typeSize.isAccessibilitySize ? 6 : 3)
                TaskMetaLine(meta: tasks.meta(task, context: Self.context))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            TaskPriorityIcon(priority: task.priority)
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
        }
        .padding(.vertical, TaskLayout.rowPadding)
        .padding(.trailing, TaskLayout.edge)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle()
                    .fill(Tokens.Line.border.color)
                    .frame(height: Tokens.Size.hairline)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(.rect)
    }

    private func open() {
        router?.openTask(task.id)
    }

    /// The store's one completion entry point, which owns the parent and
    /// repeating prompts.
    private func toggleComplete() {
        if !task.isDone { completions += 1 }
        let task = task
        Task { await tasks.requestComplete(task) }
    }
}
