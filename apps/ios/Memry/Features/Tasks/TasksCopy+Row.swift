import Foundation

// TP041. The task row's strings: its swipe actions, its context menu (desktop's
// Move menu, `phaseF.componentsTasksDragDropMoveMenu.*`, plus duplicate, parent
// and archive) and its VoiceOver summary. Mirrors
// `packages/i18n/src/locales/en/tasks.json`.

extension TasksCopy {
    // MARK: Actions

    static let rowComplete = "Complete"
    static let rowReopen = "Mark incomplete"
    static let rowDelete = "Delete"
    static let rowRescheduleTomorrow = "Reschedule to tomorrow"

    // MARK: Move menu (`componentsTasksDragDropMoveMenu`)

    static let rowReschedule = "Reschedule"
    static let rowToday = "Today"
    static let rowTomorrow = "Tomorrow"
    static let rowNextWeek = "Next week"
    static let rowRemoveDate = "Remove date"
    static let rowMoveToProject = "Move to project"
    /// `moveTo` (tasks.json).
    static let rowMoveTo = "Move to"
    static let rowChangeStatus = "Change status"
    static let rowCurrent = "Current"

    // MARK: More actions

    static let rowDuplicate = "Duplicate"
    static let rowMakeSubtaskOf = "Make subtask of..."
    static let rowArchive = "Archive"
    static let rowUnarchive = "Unarchive"

    // MARK: Duplicate dialog (`componentsTasksDialogsDuplicateWithSubtasksDialog`)

    static let rowDuplicateTitle = "Duplicate task"
    static let rowDuplicateTaskOnly = "Duplicate task"
    static let rowCancel = "Cancel"

    static func rowDuplicateMessage(_ title: String) -> String { "Create a copy of “\(title)”" }

    static func rowDuplicateWithItems(_ count: Int) -> String {
        count == 1 ? "Duplicate (1 item)" : "Duplicate (\(count) items)"
    }

    // MARK: Toasts (`toasts.drag.*`, `toasts.bulk.*`)

    static func rowRescheduledTo(_ target: String) -> String { "Rescheduled to \(target)" }
    static let rowDueDateRemoved = "Due date removed from 1 task"
    static func rowMovedTo(_ target: String) -> String { "Moved to \(target)" }
    static let rowRestored = "Tasks restored from archive"

    // MARK: Row content

    /// `task-row.tsx` shows "Done" where a completed task's date would be.
    static let rowDone = "Done"

    static func rowMoreTags(_ count: Int) -> String { "+\(count)" }

    static func rowLinkedNotes(_ count: Int) -> String {
        count == 1 ? "Linked note" : "\(count) linked notes"
    }

    // MARK: VoiceOver summary

    static let rowCompletedSuffix = "completed"
    static let rowRepeats = "Repeats"

    static func rowSubtasks(done: Int, total: Int) -> String { "\(done) of \(total) subtasks done" }
    static func rowProject(_ name: String) -> String { "Project: \(name)" }
    static func tagLabel(_ tag: String) -> String { "Tag \(tag)" }
    /// `formatDueDate`'s "Yesterday".
    static let dueYesterday = "Yesterday"
    static func rowPriority(_ value: Int64) -> String { "Priority: \(priorityLabel(value))" }
    static func rowTags(_ tags: [String]) -> String { "Tags: \(tags.joined(separator: ", "))" }

    static func rowDue(_ label: TaskDueLabel) -> String {
        label.tone == .overdue ? "Overdue, due \(label.text)" : "Due \(label.text)"
    }
}
