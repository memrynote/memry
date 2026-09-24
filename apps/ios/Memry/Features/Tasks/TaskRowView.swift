import MemryCore
import SwiftUI

// TP041, redesigned (RD01). One task row (Paper artboard 01): the status mark
// in a fixed leading lane, the title, one meta line (date, repeat, subtasks,
// note, project; `TaskMeta`), and the priority bars in a fixed trailing slot,
// so the status, title and priority lanes line up down the list. Tags are
// never in a row (they live on the detail, goal "Fixed decisions").
//
// **The status mark is its own button beside the link**, not inside it, so a
// tap on it completes and a tap anywhere else opens the task. Both go through
// the store's one entry point (`requestComplete`), which owns the parent and
// repeating prompts. In select mode the lane shows a selection circle and a
// tap anywhere selects.
//
// **VoiceOver reads one element** with the whole row as a sentence and the
// row's actions as custom actions (Complete, Reschedule to tomorrow, Delete),
// so the list is one swipe per task rather than one per badge.

/// Select mode's state for one row.
struct TaskRowSelection {
    let isSelected: Bool
    let toggle: () -> Void
}

/// TP041 — one task row.
struct TaskRowView: View {
    let task: TaskItem
    let store: TasksStore
    var depth: Int = 0
    var context = TaskMeta.Context()
    /// Non-nil in select mode.
    var selection: TaskRowSelection?

    @Environment(TasksRouter.self) private var router: TasksRouter?
    /// Accessibility sizes fit fewer words per line, so a title gets more lines.
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Bumped on each completion, driving the success haptic.
    @State private var completions = 0

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            lane
            if let selection {
                content.contentShape(.rect).onTapGesture(perform: selection.toggle)
            } else {
                NavigationLink(value: TasksRoute.task(task.id)) { content }
                    .navigationLinkIndicatorVisibility(.hidden)
            }
        }
        .padding(.leading, CGFloat(depth) * Tokens.Space.section)
        .listRowInsets(EdgeInsets(
            top: TaskLayout.rowPadding, leading: TaskLayout.edge,
            bottom: TaskLayout.rowPadding, trailing: TaskLayout.edge
        ))
        .alignmentGuide(.listRowSeparatorLeading) { _ in
            TaskLayout.lane + Tokens.Space.medium + CGFloat(depth) * Tokens.Space.section
        }
        .sensoryFeedback(.success, trigger: completions)
        .modifier(TaskRowActions(task: task, store: store, complete: toggleComplete))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(store.rowAccessibilityLabel(task))
        .accessibilityAddTraits(selection?.isSelected == true ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction {
            if let selection { selection.toggle() } else { router?.open(.task(task.id)) }
        }
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

    @ViewBuilder private var lane: some View {
        if let selection {
            TaskStatusLane(action: selection.toggle, label: TasksCopy.moreSelect, identifier: "tasks.row.select") {
                TaskSelectionMark(isSelected: selection.isSelected)
            }
        } else {
            TaskStatusLane(
                action: toggleComplete,
                label: task.isDone ? TasksCopy.rowReopen : TasksCopy.rowComplete,
                identifier: "tasks.row.status"
            ) {
                TaskStatusIcon(
                    statusType: task.statusType,
                    isDone: task.isDone,
                    color: store.rowStatus(task).map { Tokens.Palette.color($0.color) }
                )
            }
        }
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
                TaskMetaLine(meta: store.meta(task, context: context))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            TaskPriorityIcon(priority: task.priority)
                .frame(minWidth: Tokens.Space.inset, alignment: .trailing)
        }
        .contentShape(.rect)
    }

    private func toggleComplete() {
        if !task.isDone { completions += 1 }
        let task = task
        Task { await store.requestComplete(task) }
    }
}

/// Select mode's circle: an empty ring, or the tint filled with an ink check.
struct TaskSelectionMark: View {
    let isSelected: Bool

    var body: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .font(Tokens.Typography.body.font)
            .imageScale(.large)
            .symbolRenderingMode(isSelected ? .palette : .monochrome)
            .foregroundStyle(
                isSelected ? Tokens.Tint.foreground.color : Tokens.Text.tertiary.color,
                Tokens.Tint.base.color
            )
            .accessibilityHidden(true)
    }
}
