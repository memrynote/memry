import Foundation

// TP047 / TP051 copy, mirroring desktop's English `tasks.json`
// (`toasts.bulk.*`, `toasts.alreadyAllComplete`, `toasts.noCompletedSelected`,
// `phaseF.componentsTasksBulkActions*`, `phaseI.toasts.changesUndone`) and
// `common.json` (`toast.undone`, `shortcuts.tasks.*`).

extension TasksCopy {
    // MARK: Plurals

    /// `1 task` / `3 tasks`.
    static func taskCount(_ count: Int) -> String {
        count == 1 ? "1 task" : "\(count) tasks"
    }

    // MARK: Bar (`componentsTasksBulkActionsBulkActionToolbar`)

    static let bulkActions = "Bulk actions"
    static let bulkComplete = "Complete"
    static let bulkPriority = "Priority"
    static let bulkDueDate = "Due Date"
    static let bulkMoveTo = "Move to"
    static let bulkStatus = "Status"
    static let bulkArchive = "Archive"
    static let bulkUnarchive = "Unarchive"
    static let bulkDelete = "Delete"
    static let cancelSelection = "Cancel selection"
    static let selectAll = "Select all"
    static let deselectAll = "Deselect all"

    static func selectedCount(_ count: Int) -> String { "\(count) selected" }

    // MARK: Priority menu

    static let removePriority = "Remove priority"

    /// `priorityInline.*`, the word inside "Priority set to high".
    static func priorityInline(_ value: Int64) -> String {
        priorityLabel(value).lowercased()
    }

    // MARK: Due date menu (`bulk-action-toolbar.tsx` `dueDateOptions`)

    static let dueToday = "Today"
    static let dueTomorrow = "Tomorrow"
    static let dueNextWeek = "Next week"
    static let dueNextMonth = "Next month"
    static let duePickDate = "Pick a date..."
    static let dueRemove = "Remove due date"

    /// `componentsTasksBulkActionsBulkDueDatePicker.setDueDateFor`.
    static func setDueDateFor(_ count: Int) -> String { "Set due date for \(taskCount(count))" }

    // MARK: Delete dialog (`componentsTasksBulkActionsBulkDeleteDialog`)

    static func deleteTitle(_ count: Int) -> String { "Delete \(taskCount(count))?" }
    static func deleteConfirm(_ count: Int) -> String { "Delete \(taskCount(count))" }
    static let deleteCancel = "Cancel"
    static let deleteUndoHint = "This action can be undone for a short time after deletion."

    /// "You're about to delete 7 tasks:", up to five titles, "... and 2 more
    /// tasks", then the undo hint.
    static func deleteMessage(titles: [String], total: Int) -> String {
        let visible = titles.prefix(5).map { "• \($0)" }
        var lines = ["You're about to delete \(taskCount(total)):"] + visible
        let remaining = total - visible.count
        if remaining > 0 {
            lines.append(remaining == 1 ? "... and 1 more task" : "... and \(remaining) more tasks")
        }
        lines.append("")
        lines.append(deleteUndoHint)
        return lines.joined(separator: "\n")
    }

    // MARK: Toasts (`toasts.bulk.*`)

    static let alreadyAllComplete = "All selected tasks are already complete"
    static let noCompletedSelected = "No completed tasks selected"

    static func bulkRestored(_ count: Int) -> String {
        count == 1 ? "1 task restored" : "\(count) tasks restored"
    }

    static func bulkPrioritySet(_ count: Int, priority: Int64) -> String {
        priority == 0
            ? "Priority removed for \(taskCount(count))"
            : "Priority set to \(priorityInline(priority)) for \(taskCount(count))"
    }

    static func bulkDueDateSet(_ count: Int) -> String { "Due date set for \(taskCount(count))" }
    static func bulkDueDateRemoved(_ count: Int) -> String { "Due date removed from \(taskCount(count))" }
    static func bulkMoved(_ count: Int, project: String) -> String { "\(taskCount(count)) moved to \(project)" }
    static func bulkMovedToStatus(_ count: Int, status: String) -> String { "\(taskCount(count)) moved to \(status)" }
    static func bulkArchived(_ count: Int) -> String { "\(taskCount(count)) archived" }
    static func bulkDeleted(_ count: Int) -> String { "\(taskCount(count)) deleted" }

    /// `toasts.bulk.unarchived`, pluralised (desktop's string has no plural
    /// form and reads "1 tasks").
    static func bulkUnarchived(_ count: Int) -> String { "\(taskCount(count)) restored from archive" }

    // MARK: Undo (`phaseI.toasts.changesUndone`, common `toast.undone`)

    static let changesUndone = "Changes undone"
    static func undone(_ description: String) -> String { "Undone: \(description)" }
    static let undoHint = "Reverts the last change"

    // MARK: Hardware keyboard (common `shortcuts.tasks.*`)

    static let shortcutSelectAll = "Select all visible tasks"
    static let shortcutClearSelection = "Clear task selection"
    static let shortcutComplete = "Complete selected tasks"
    static let shortcutDelete = "Delete selected tasks"
}
