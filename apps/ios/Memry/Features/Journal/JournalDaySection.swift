import MemryCore
import SwiftUI

// JP050. The Day section under the entry (Paper J01, J03, J10): the tasks due
// on the day, each with its status, priority and project, and on today the
// overdue count that opens Tasks. Desktop's `JournalDayPanel`
// (`components/journal/journal-day-panel.tsx`): tasks with `dueDate` on the
// day, completed included, archived not, by priority; the overdue count only
// on today; the whole panel hidden when the day has no task. The schedule
// half waits for the calendar on the phone (Paper 00-audit).
//
// Every write goes through the vault's `TasksStore` (its sync included); a
// task opens in the Tasks tab through `TasksRouter`.

struct JournalDaySection: View {
    let store: JournalStore
    let date: String

    @Environment(\.journalTasks) private var tasks

    var body: some View {
        if let tasks {
            JournalDueTasks(tasks: tasks, date: date, today: store.clock.today)
        }
    }
}

/// Which tasks the Day section shows, off the view so a test reads it.
enum JournalDayTasks {
    /// Tasks due on `date` (`dueDate` from `date` to `date`, completed
    /// included, archived not), highest priority first, list order within a
    /// priority (desktop `sortBy: 'priority', sortOrder: 'desc'`).
    static func due(on date: String, in tasks: [TaskItem]) -> [TaskItem] {
        tasks.enumerated()
            .filter { $0.element.archivedAt == nil && day(of: $0.element) == date }
            .sorted { lhs, rhs in
                lhs.element.priority != rhs.element.priority
                    ? lhs.element.priority > rhs.element.priority
                    : lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// Open, unarchived tasks due before `today` (desktop `getTaskStats`
    /// `overdue`).
    static func overdueCount(before today: String, in tasks: [TaskItem]) -> Int {
        tasks.count { task in
            guard task.archivedAt == nil, task.completedAt == nil, let day = day(of: task) else { return false }
            return day < today
        }
    }

    /// The `YYYY-MM-DD` part of a stored due date, which may carry a time.
    private static func day(of task: TaskItem) -> String? {
        guard let due = task.dueDate, due.count >= 10 else { return nil }
        return String(due.prefix(10))
    }
}

/// The section over a present tasks store.
private struct JournalDueTasks: View {
    let tasks: TasksStore
    let date: String
    let today: String

    @Environment(TasksRouter.self) private var router: TasksRouter?

    private var due: [TaskItem] { JournalDayTasks.due(on: date, in: tasks.ordered) }
    private var overdue: Int {
        date == today ? JournalDayTasks.overdueCount(before: today, in: tasks.ordered) : 0
    }

    var body: some View {
        // A container even when empty, so the load below runs on a day that
        // has nothing to show yet.
        VStack(alignment: .leading, spacing: 0) {
            let due = due
            if !due.isEmpty {
                Divider()
                    .overlay(Tokens.Line.border.color)
                header(count: due.count)
                ForEach(due, id: \.id) { task in
                    JournalDayTaskRow(task: task, tasks: tasks, isLast: task.id == due.last?.id)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.normal, value: due.map(\.id))
        .task {
            // The Tasks tab loads the store when it first shows; a journal
            // opened first reads it here.
            if tasks.projects.isEmpty, tasks.ordered.isEmpty, !tasks.isLoading { await tasks.load() }
        }
    }

    private func header(count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                Text(date == today ? JournalCopy.Section.dueToday : JournalCopy.Section.due(on: date))
                    .font(Tokens.Typography.label.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                Text(verbatim: "\(count)")
                    .font(Tokens.Typography.label.font.weight(.regular))
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "\(date == today ? JournalCopy.Section.dueToday : JournalCopy.Section.due(on: date)), "
                    + JournalCopy.Section.taskCount(count)
            )
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Tokens.Space.small)
            if overdue > 0 {
                overduePill(overdue)
            }
        }
        .padding(.top, Tokens.Space.small)
        .padding(.horizontal, TaskLayout.edge)
    }

    /// Opens the Tasks tab (desktop opens the Tasks tab).
    private func overduePill(_ count: Int) -> some View {
        Button {
            guard let router else { return }
            router.path = []
            // Desktop `handleNavigateToOverdue` opens the Tasks tab as it
            // stands (stored view, else the default view); no view forced.
            router.selectedTab = .tasks
        } label: {
            HStack(spacing: Tokens.Space.tight) {
                Circle()
                    .fill(Tokens.Task.dueOverdue.color)
                    .frame(width: Tokens.Space.tight, height: Tokens.Space.tight)
                    .accessibilityHidden(true)
                Text(JournalCopy.Section.overdue(count))
                    .font(Tokens.Typography.caption.font.weight(.medium))
                    .foregroundStyle(Tokens.Task.dueOverdue.color)
            }
            .padding(.horizontal, Tokens.Space.small)
            .padding(.vertical, Tokens.Space.tight / 2)
            .background(Tokens.Task.dueOverdue.color.opacity(Tokens.Palette.chipFillAlpha), in: .capsule)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(router == nil)
        .accessibilityLabel(JournalCopy.Section.overdue(count))
        .accessibilityHint(JournalCopy.Section.overdueHint)
        .accessibilityIdentifier("journal.day.overdue")
    }
}
