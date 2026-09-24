import SwiftUI

// TP040, redesigned (RD20). The list's empty states (Paper artboard 20): a
// small glyph, the title, and either the next useful view ("6 tasks due
// tomorrow." + "Show tomorrow") or the view's own description and action, in
// desktop's copy (`task-empty-state.tsx`, `today-empty-state.tsx`,
// `upcoming-empty-state.tsx`, `filters/filter-empty-state.tsx`). Leading
// aligned, calm, never confetti.

/// A view the empty state can send the user to, and how much waits there.
struct TaskListEmptyNext: Equatable {
    let tab: TasksTab
    let count: Int
}

extension TasksStore {
    /// The next view with open tasks: Today → Tomorrow → Next 7 days;
    /// Tomorrow → Next 7 days; Next 7 days → All.
    var listEmptyNext: TaskListEmptyNext? {
        let chain: [TasksTab] = switch state.tab {
        case .today: [.tomorrow, .next7]
        case .tomorrow: [.next7]
        case .next7: [.all]
        case .all, .archived: []
        }
        return chain.lazy.map { TaskListEmptyNext(tab: $0, count: self.tabCount($0)) }.first { $0.count > 0 }
    }
}

/// One empty state, with its action.
struct TaskListEmptyView: View {
    let state: TaskListEmptyState
    let next: TaskListEmptyNext?
    let addTask: () -> Void
    let show: (TasksTab) -> Void
    let clearFilters: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Image(systemName: symbol)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(symbolColor)
                .accessibilityHidden(true)
            Text(title)
                .font(TypeRole(.subsectionTitle, weight: .semibold).font)
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(.top, Tokens.Space.tight)
                .accessibilityAddTraits(.isHeader)
            if let detail {
                Text(detail)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            if let action {
                Button(action.title, action: action.run)
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tint.color)
                    .buttonStyle(.plain)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier(action.identifier)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Tokens.Space.screenBlock)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.empty")
    }

    private var symbol: String {
        switch state {
        case .filtered: "magnifyingglass"
        case .today: "checkmark.circle.fill"
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

    /// The next view's count where there is one, else the view's own line.
    private var detail: String? {
        if state != .filtered, let next {
            return TasksCopy.nextViewHint(next.count, view: TasksCopy.tabTitle(next.tab))
        }
        return switch state {
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
        if state != .filtered, let next {
            let tab = next.tab
            return Action(
                title: TasksCopy.showView(TasksCopy.tabTitle(tab)),
                identifier: "tasks.empty.showNext",
                run: { show(tab) }
            )
        }
        return switch state {
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
