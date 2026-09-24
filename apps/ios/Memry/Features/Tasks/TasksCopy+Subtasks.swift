import Foundation

// TP046. The subtask surfaces' strings, mirroring desktop's English
// `packages/i18n/src/locales/en/tasks.json` (`drawer.*`, `toasts.subtasks.*`,
// `phaseI.toasts.*` and the `phaseF.componentsTasksDialogs*` dialogs).
// Every name carries a `subtask`/`parentPicker` stem so no other block's
// extension of ``TasksCopy`` collides with it.

extension TasksCopy {
    // MARK: Section (`drawer.*`)

    static let subtasksTitle = "Sub-issues"
    static let subtaskAdd = "Add sub-issue"
    static let subtaskAddPlaceholder = "Add sub-issue…"
    static let subtasksEmpty = "No sub-issues yet"
    static let subtaskBulkMenu = "Subtask actions"

    static func subtaskCount(done: Int, total: Int) -> String { "\(done) / \(total)" }

    static func subtaskCountLabel(done: Int, total: Int) -> String {
        "\(done) of \(total) subtasks complete"
    }

    static func subtaskRowLabel(_ title: String, isDone: Bool) -> String {
        isDone ? "Subtask: \(title), completed" : "Subtask: \(title)"
    }

    // MARK: Row actions

    static let subtaskOpen = "Open"
    static let subtaskPromote = "Promote to task"
    static let subtaskMoveUp = "Move up"
    static let subtaskMoveDown = "Move down"
    static let subtaskDelete = "Delete"
    static let subtaskComplete = "Complete"
    static let subtaskReopen = "Mark incomplete"

    // MARK: Bulk menu (`subtask-bulk-utils.ts`)

    static let subtaskCompleteAll = "Complete all"
    static let subtaskMarkAllIncomplete = "Mark all incomplete"
    static let subtaskSetDueForAll = "Set due date for all subtasks"
    static let subtaskSetPriorityForAll = "Set priority for all subtasks"
    static let subtaskDeleteAllAction = "Delete all subtasks"
    static let subtaskDeleteAllTitle = "Delete all subtasks?"
    static let subtaskDeleteAllConfirm = "Delete All"
    static let subtaskCancel = "Cancel"
    static let subtaskApply = "Apply"

    static func subtaskDeleteAllMessage(count: Int, title: String) -> String {
        "This will delete \(subtaskNoun(count)) from “\(title)”."
    }

    static func subtaskSetPriorityMessage(count: Int, title: String) -> String {
        "Set priority for \(subtaskNoun(count)) in “\(title)”"
    }

    static func subtaskAlsoApplyToCompleted(_ count: Int) -> String {
        "Also apply to completed subtasks (\(count))"
    }

    // MARK: Complete-parent dialog

    static let subtaskCompleteParentTitle = "Complete task with incomplete subtasks?"
    static let subtaskCompleteParentAll = "Complete all (parent + subtasks)"
    static let subtaskCompleteParentOnly = "Complete parent only, keep subtasks incomplete"
    static let subtaskWhatToDo = "What would you like to do?"

    static func subtaskCompleteParentMessage(title: String, open: [String]) -> String {
        let noun = open.count == 1 ? "incomplete subtask" : "incomplete subtasks"
        var lines = ["“\(title)” has \(open.count) \(noun):"]
        lines += open.prefix(5).map { "• \($0)" }
        if open.count > 5 { lines.append("…and \(open.count - 5) more") }
        lines.append(subtaskWhatToDo)
        return lines.joined(separator: "\n")
    }

    // MARK: All-subtasks-complete dialog

    static let subtaskAllCompleteTitle = "All subtasks complete!"
    static let subtaskKeepParentOpen = "Keep task open"
    static let subtaskCompleteParentNow = "Complete task"

    static func subtaskAllDoneMessage(title: String, count: Int) -> String {
        "“\(title)” has all \(subtaskNoun(count)) done. Would you like to mark the parent task as complete too?"
    }

    // MARK: Delete-parent dialog

    static let subtaskDeleteParentTitle = "Delete task with subtasks?"
    static let subtaskDeleteParentAll = "Delete task and all subtasks"
    static let subtaskDeleteParentKeep = "Delete task, keep subtasks as standalone tasks"

    static func subtaskDeleteParentMessage(title: String, count: Int) -> String {
        "“\(title)” has \(subtaskNoun(count)). \(subtaskWhatToDo)"
    }

    // MARK: Duplicate dialog

    static let subtaskDuplicateTitle = "Duplicate task"
    static let subtaskDuplicateTaskOnly = "Duplicate task"

    static func subtaskDuplicateMessage(title: String) -> String { "Create a copy of “\(title)”" }

    static func subtaskDuplicateWithItems(_ count: Int) -> String {
        count == 1 ? "Duplicate (1 item)" : "Duplicate (\(count) items)"
    }

    // MARK: Parent picker

    static let parentPickerTitle = "Make subtask of..."
    static let parentPickerSearch = "Search tasks..."
    static let parentPickerSameProject = "Same Project"
    static let parentPickerOtherProjects = "Other Projects"
    static let parentPickerNoMatches = "No tasks found matching your search"
    static let parentPickerNoCandidates = "No available tasks to make this a subtask of"
    static let parentPickerHasSubtasks = "Cannot make a parent task into a subtask"

    static func parentPickerSameProjectHeader(_ name: String?) -> String {
        name.map { "\(parentPickerSameProject) (\($0))" } ?? parentPickerSameProject
    }

    static func parentPickerMessage(_ title: String) -> String {
        "Select a task to make \"\(title)\" a subtask of."
    }

    // MARK: Toasts (`toasts.subtasks.*`, `phaseI.toasts.*`)

    static let subtaskAdded = "Subtask added"
    static let subtaskDeleted = "Subtask deleted"
    static let subtaskParentKeptOpen = "Task kept open"
    static let subtaskParentAndSubtasksCompleted = "Task and subtasks completed"
    static let subtaskParentDeletedKeepSubtasks = "Task deleted, subtasks converted to tasks"
    static let subtaskParentDeletedWithSubtasks = "Task and subtasks deleted"

    static func subtaskPromoted(_ title: String) -> String { "\"\(title)\" promoted to task" }

    static func subtaskMovedUnder(_ title: String) -> String { "Moved under \"\(title)\"" }

    static func subtasksCompleted(_ count: Int) -> String {
        count == 1 ? "1 subtask completed" : "\(count) subtasks completed"
    }

    static func subtasksMarkedIncomplete(_ count: Int) -> String {
        count == 1 ? "1 subtask marked incomplete" : "\(count) subtasks marked incomplete"
    }

    static func subtasksDueSet(_ count: Int) -> String {
        count == 1 ? "Due date set for 1 subtask" : "Due date set for \(count) subtasks"
    }

    static func subtasksDueCleared(_ count: Int) -> String {
        count == 1 ? "Due date cleared for 1 subtask" : "Due date cleared for \(count) subtasks"
    }

    static func subtasksPrioritySet(_ count: Int) -> String {
        count == 1 ? "Priority set for 1 subtask" : "Priority set for \(count) subtasks"
    }

    static func subtasksDeleted(_ count: Int) -> String {
        count == 1 ? "1 subtask deleted" : "\(count) subtasks deleted"
    }

    private static func subtaskNoun(_ count: Int) -> String {
        count == 1 ? "1 subtask" : "\(count) subtasks"
    }
}
