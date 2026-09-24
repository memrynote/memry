import SwiftUI

// TP040. The list's empty states and Today's progress, in desktop's copy:
// `task-empty-state.tsx`, `today-empty-state.tsx`, `upcoming-empty-state.tsx`,
// `empty-states/simple-empty-state.tsx`, `filters/filter-empty-state.tsx`, and
// the completed-today count `pages/tasks.tsx` keeps for the day's progress.
// Calm, never confetti: a bar, a count, and a check when the day is done.

/// One empty state, with its action.
struct TaskListEmptyView: View {
    let state: TaskListEmptyState
    let addTask: () -> Void
    let clearFilters: () -> Void

    var body: some View {
        VStack(spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(symbolColor)
                .accessibilityHidden(true)
            Text(title)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .multilineTextAlignment(.center)
            if let description {
                Text(description)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .multilineTextAlignment(.center)
            }
            if let action {
                Button(action.title, action: action.run)
                    .buttonStyle(.bordered)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier(action.identifier)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Tokens.Space.screenBlock)
        .padding(.horizontal, Tokens.Space.screenInline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.empty")
    }

    private var symbol: String {
        switch state {
        case .filtered: "magnifyingglass"
        case .today: "checkmark.circle"
        case .tomorrow, .next7: "calendar"
        case .project: "folder"
        case .all, .archived: "list.clipboard"
        }
    }

    private var symbolColor: Color {
        state == .today ? Tokens.Task.complete.color : Tokens.Text.tertiary.color
    }

    private var title: String {
        switch state {
        case .filtered: TasksCopy.filtersEmptyTitle
        case .all, .archived: TasksCopy.allEmptyTitle
        case let .project(name): TasksCopy.projectEmptyTitle(name)
        case .today: TasksCopy.todayEmptyTitle
        case .tomorrow: TasksCopy.tomorrowEmptyTitle
        case .next7: TasksCopy.next7EmptyTitle
        }
    }

    private var description: String? {
        switch state {
        case .filtered: TasksCopy.filtersEmptyHelp
        case .all: TasksCopy.allEmptyDescription
        case .project: TasksCopy.projectEmptyDescription
        case .today: TasksCopy.todayEmptyDescription
        case .next7: TasksCopy.next7EmptyDescription
        case .tomorrow, .archived: nil
        }
    }

    private struct Action {
        let title: String
        let identifier: String
        let run: () -> Void
    }

    private var action: Action? {
        switch state {
        case .filtered:
            Action(title: TasksCopy.clearAllFilters, identifier: "tasks.empty.clearFilters", run: clearFilters)
        case .all, .project:
            Action(title: TasksCopy.addTaskButton, identifier: "tasks.empty.add", run: addTask)
        case .today:
            Action(title: TasksCopy.addTaskForToday, identifier: "tasks.empty.add", run: addTask)
        case .tomorrow:
            Action(title: TasksCopy.addTaskForTomorrow, identifier: "tasks.empty.add", run: addTask)
        case .next7:
            Action(title: TasksCopy.addTaskShort, identifier: "tasks.empty.add", run: addTask)
        case .archived:
            nil
        }
    }
}

/// Today's progress: tasks completed today against everything on Today.
struct TaskTodayProgress: View {
    let done: Int
    let total: Int

    private var isComplete: Bool { done == total }

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            ProgressView(value: Double(done), total: Double(max(total, 1)))
                .tint(isComplete ? Tokens.Task.complete.color : Tokens.Task.progress.color)
                .accessibilityHidden(true)
            if isComplete {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Tokens.Task.complete.color)
                    .accessibilityHidden(true)
                    .transition(.opacity)
            }
            Text(isComplete ? TasksCopy.allCaughtUp : TasksCopy.todayProgress(done: done, total: total))
                .font(Tokens.Typography.caption.font.monospacedDigit())
                .foregroundStyle(isComplete ? Tokens.Task.complete.color : Tokens.Text.secondary.color)
                .fixedSize()
        }
        .calmAnimation(.normal, value: isComplete)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            isComplete ? TasksCopy.allCaughtUp : TasksCopy.todayProgress(done: done, total: total)
        )
        .accessibilityValue("\(done) / \(total)")
        .accessibilityIdentifier("tasks.progress")
    }
}
