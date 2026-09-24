import Foundation

// TP054 / TP056. The words the note screen and vault search say about tasks,
// after desktop's `notes.json` (`linkedTasks.*`, the task block renderer, the
// checklist context menu) and `common.json`'s search groups.

extension TasksCopy {
    // MARK: Task block (`componentsNoteContentAreaTaskBlockTaskBlockRenderer`)

    static let openInTasks = "Open in Tasks"
    static let completeTask = "Complete task"
    static let reopenTask = "Reopen task"
    static let taskDone = "Done"
    static let taskNotDone = "Not done"
    /// A task line whose task this vault does not hold (not pulled yet, or
    /// deleted on another device). Desktop hands such a row no controls.
    static let taskNotHere = "This task is not on this phone"

    static func blockPriority(_ value: Int64) -> String {
        "Priority: \(priorityLabel(value))"
    }

    static func blockProject(_ name: String) -> String { "Project: \(name)" }

    static func blockDue(_ label: String) -> String { "Due \(label)" }

    // MARK: Checklist → task (desktop's checklist context menu)

    static let convertToTask = "Convert to task"
    static let indentLine = "Indent"
    static let outdentLine = "Outdent"
    static let convertRefusedTitle = "This line cannot become a task"
    static let convertRefusedGuidance =
        "Only a checklist item with text, not already linked to a task, can be converted."
    static let taskActionFailedTitle = "The task was not changed"
    static let dismiss = "OK"

    // MARK: Linked tasks (`linkedTasks.*`)

    static let linkedTasksTitle = "Linked Tasks"
    static let linkedTasksExpanded = "Expanded"
    static let linkedTasksCollapsed = "Collapsed"
    static let writtenInThisNote = "Written in this note"
    static let mentionsThisNote = "Mentions this note"

    static func linkedTasksHeader(_ count: Int) -> String {
        "\(linkedTasksTitle), \(count)"
    }

    static func linkedTaskSubtitle(fromThisNote: Bool, due: String?) -> String {
        let origin = fromThisNote ? writtenInThisNote : mentionsThisNote
        guard let due else { return origin }
        return "\(origin) · due \(due)"
    }

    static func linkedTaskLabel(title: String, isDone: Bool, subtitle: String) -> String {
        "\(title), \(isDone ? taskDone : taskNotDone), \(subtitle)"
    }

    // MARK: Search (`common.json` `groupTasks`)

    static let searchTasksSection = "Tasks"
    static let searchNotesSection = "Notes"
    static let untitledTask = "Untitled task"
}
