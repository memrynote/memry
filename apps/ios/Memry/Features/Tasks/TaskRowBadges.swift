import MemryCore
import SwiftUI

// TP041. The row's second line, after desktop's `task-row.tsx` and
// `task-badges.tsx`: due (or "Done" once completed), project, subtask
// progress, repeat, linked note, and at most three tags with a "+N".
//
// It wraps rather than truncates, so a large Dynamic Type size pushes badges
// onto a new line instead of cutting the date off.

/// Desktop's `DEFAULT_MAX_VISIBLE_TAGS`.
private let maxVisibleTags = 3

struct TaskRowBadges: View {
    let task: TaskItem
    let store: TasksStore
    let showsProject: Bool

    var body: some View {
        if hasBadges {
            FlowLayout(spacing: Tokens.Space.small) {
                due
                if showsProject, let project = store.project(task.projectId) {
                    TaskProjectChip(name: project.name, color: project.color)
                }
                let counts = store.rowSubtaskCounts(task)
                TaskSubtaskProgress(done: counts.done, total: counts.total)
                if task.repeat != nil {
                    TaskRepeatIndicator(rule: task.repeat)
                }
                TaskRowLinkedNoteMark(notes: store.rowLinkedNoteCount(task))
                ForEach(task.tags.prefix(maxVisibleTags), id: \.self) { tag in
                    TaskTagChip(tag: tag)
                }
                if task.tags.count > maxVisibleTags {
                    Text(TasksCopy.rowMoreTags(task.tags.count - maxVisibleTags))
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
        }
    }

    @ViewBuilder private var due: some View {
        if task.isDone {
            Text(TasksCopy.rowDone)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Task.complete.color)
        } else if let label = store.dueLabel(task) {
            TaskDueBadge(label: label)
        }
    }

    private var hasBadges: Bool {
        task.isDone
            || task.dueDate != nil
            || (showsProject && store.project(task.projectId) != nil)
            || store.rowSubtaskCounts(task).total > 0
            || task.repeat != nil
            || store.rowLinkedNoteCount(task) > 0
            || !task.tags.isEmpty
    }
}

/// The linked note mark, with a count past one.
private struct TaskRowLinkedNoteMark: View {
    let notes: Int

    var body: some View {
        if notes >= 1 {
            HStack(spacing: Tokens.Space.tight) {
                Image(systemName: "doc.text")
                if notes > 1 { Text(notes.formatted()) }
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(TasksCopy.rowLinkedNotes(notes))
        }
    }
}
