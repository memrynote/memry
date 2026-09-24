import MemryCore
import SwiftUI

// TP041. One task row, after desktop's `task-row.tsx` / `parent-task-row.tsx`:
// the status circle, the priority mark, the title (struck through when done),
// then a wrapping line of badges (`task-badges.tsx`): due, project, subtask
// progress, repeat, linked note, tags.
//
// **The circle is its own button beside the link**, not inside it, so a tap on
// it completes and a tap anywhere else opens the task. Both go through the
// store's one entry point (`requestComplete`), which owns the parent and
// repeating prompts.
//
// **VoiceOver reads one element** with the whole row as a sentence and the
// row's actions as custom actions (Complete, Reschedule to tomorrow, Delete),
// so the list is one swipe per task rather than one per badge.

/// TP041 — one task row.
struct TaskRowView: View {
    let task: TaskItem
    let store: TasksStore
    var depth: Int = 0
    /// Whether the project chip may show; the page hides it anyway when it is
    /// already scoped to one project, and subtasks never repeat their parent's.
    var showsProject: Bool = true

    @Environment(TasksRouter.self) private var router: TasksRouter?
    /// Bumped on each completion, driving the success haptic.
    @State private var completions = 0

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            TaskRowStatusButton(task: task, status: store.rowStatus(task), action: toggleComplete)
            NavigationLink(value: TasksRoute.task(task.id)) {
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    title
                    TaskRowBadges(task: task, store: store, showsProject: projectVisible)
                }
            }
        }
        .padding(.leading, CGFloat(depth) * Tokens.Space.section)
        .sensoryFeedback(.success, trigger: completions)
        .modifier(TaskRowActions(task: task, store: store, complete: toggleComplete))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(store.rowAccessibilityLabel(task))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { router?.open(.task(task.id)) }
        .accessibilityAction(named: task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete) {
            toggleComplete()
        }
        .accessibilityAction(named: TasksCopy.rowRescheduleTomorrow) {
            let task = task
            Task { await store.rowReschedule(task, to: .tomorrow) }
        }
        .accessibilityAction(named: TasksCopy.rowDelete) {
            let task = task
            Task { await store.requestDelete(task) }
        }
        .accessibilityIdentifier("tasks.row.\(task.id)")
    }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.tight) {
            TaskPriorityIcon(priority: task.priority)
            Text(task.title)
                .font(Tokens.Typography.body.font)
                .strikethrough(task.isDone)
                .foregroundStyle(task.isDone ? Tokens.Text.tertiary.color : Tokens.Text.primary.color)
                .multilineTextAlignment(.leading)
                .lineLimit(3)
        }
    }

    private var projectVisible: Bool {
        showsProject && depth == 0 && store.state.projectId == nil
    }

    private func toggleComplete() {
        if !task.isDone { completions += 1 }
        let task = task
        Task { await store.requestComplete(task) }
    }
}

/// The status circle: completes an open task, reopens a done one.
private struct TaskRowStatusButton: View {
    let task: TaskItem
    let status: StatusItem?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TaskStatusIcon(
                statusType: task.statusType,
                isDone: task.isDone,
                color: status.map { Tokens.Palette.color($0.color) }
            )
            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete)
        .accessibilityIdentifier("tasks.row.status")
    }
}
