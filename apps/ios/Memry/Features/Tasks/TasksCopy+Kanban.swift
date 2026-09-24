import Foundation

// TP049. The kanban board's strings, from desktop's `tasks.json`
// (`kanban.*`, `toasts.drag.*`, `filters.groupByFields.*`,
// `phaseF.componentsTasksKanbanKanbanColumn.*`).

extension TasksCopy {
    // MARK: Board

    static let kanbanBoard = "Kanban board"
    static let kanbanGroupBy = "Group by"
    static let kanbanColumnsLabel = "Columns"

    static func kanbanModeLabel(_ mode: KanbanColumnMode) -> String {
        switch mode {
        case .canonical, .status: "Status"
        case .priority: "Priority"
        case .dueDate: "Due date"
        case .project: "Project"
        }
    }

    // MARK: Column

    static let kanbanTaskTitle = "Task title..."
    static let kanbanShowFewer = "Show fewer"

    static func kanbanMoreCompleted(_ count: Int) -> String { "\(count) more completed" }

    static func kanbanAddTo(_ column: String) -> String { "Add task to \(column)" }

    static func kanbanColumnSummary(_ column: String, count: Int) -> String {
        count == 1 ? "\(column) column, 1 task" : "\(column) column, \(count) tasks"
    }

    static let kanbanEmptyTitle = "No tasks"
    static let kanbanEmptySubtitle = "Drag tasks here or tap + to add"
    static let kanbanEmptyDoneTitle = "No completed tasks"
    static let kanbanEmptyDoneSubtitle = "Complete tasks to see them here"
    static let kanbanEmptyScheduleTitle = "Nothing scheduled"
    static let kanbanEmptyScheduleSubtitle = "Drag tasks here to reschedule"
    static let kanbanDropHere = "Drop here"

    // MARK: Card

    static let kanbanMoveTo = "Move to"
    static let kanbanComplete = "Complete"
    static let kanbanReopen = "Mark as not done"
    static let kanbanOpen = "Open task"
    static let kanbanDelete = "Delete"
    static let kanbanJustNow = "Just now"

    static func kanbanPriority(_ value: Int64) -> String { "Priority: \(priorityLabel(value))" }

    static func kanbanMoveAction(_ column: String) -> String { "Move to \(column)" }

    static func kanbanLinkedNotes(_ count: Int) -> String {
        count == 1 ? "1 linked note" : "\(count) linked notes"
    }

    static func kanbanCompletedAgo(_ relative: String) -> String { "Completed \(relative)" }

    // MARK: Toasts (`toasts.drag.*`)

    static func kanbanPrioritySet(_ priority: String) -> String { "Priority set to \(priority)" }

    static func kanbanRescheduled(_ target: String) -> String { "Rescheduled to \(target)" }

    static func kanbanMoved(_ target: String) -> String { "Moved to \(target)" }
}
