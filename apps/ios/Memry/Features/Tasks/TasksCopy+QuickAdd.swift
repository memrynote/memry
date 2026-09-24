import Foundation

// TP042. Quick add and the Add Task sheet, mirroring desktop's English
// `tasks.json` (`quickAdd.*`, `task.*`, `phaseF.componentsTasksQuickAdd*`) and
// `common.json` (`button.*`, `capture.*`).

extension TasksCopy {
    // MARK: Quick add (`quickAdd.*`)

    static let quickAddLabel = "Quick add task"
    static let quickAddPlaceholder = "Add a task…  @tomorrow  !high  +project  #tag"
    /// At accessibility text sizes the token hints would fill the screen; the
    /// help sheet still lists them.
    static let quickAddPlaceholderShort = "Add a task…"
    static let quickAddSubmit = "Add task"
    static let quickAddOpenDetail = "Open in Add Task"
    static let quickAddAccept = "Accept suggestion"
    static let quickAddSuggestions = "Suggestions"
    static let quickAddNoProject = "Create a project first to add tasks."

    static func quickAddAcceptSuggestion(_ completion: String) -> String {
        "Complete to \(completion)"
    }

    static func quickAddResolvedDate(_ display: String) -> String { "Due \(display)" }

    static func quickAddProjectTarget(_ name: String) -> String { "Adds to \(name)" }

    static func quickAddPickProject(_ name: String) -> String { "Project \(name)" }

    static func quickAddPickTag(_ tag: String) -> String { "Tag \(tag)" }

    static func quickAddPickNote(_ title: String) -> String { "Link note \(title)" }

    // MARK: Help (`phaseF.componentsTasksQuickAddQuickAddHelp.*`)

    static let quickAddHelp = "Quick add shortcuts help"
    static let quickAddHelpTitle = "Quick Add Shortcuts"
    static let quickAddHelpExample = "Example: \"Buy milk @tomorrow 5pm !high +personal #errand\""

    /// The syntax the core parses (D1: English, `@` before a date).
    static let quickAddHelpRows: [(syntax: String, meaning: String)] = [
        ("@today", "Due today"),
        ("@tomorrow 3pm", "Due tomorrow at 3 PM"),
        ("@next monday", "Due next Monday"),
        ("@may 17", "Due on a date"),
        ("every monday", "Repeats every Monday"),
        ("every 2 weeks", "Repeats every two weeks"),
        ("!high", "High priority (!urgent, !medium, !low)"),
        ("+project", "Assign to project"),
        ("#tag", "Add a tag"),
        ("[[Note]]", "Link a note")
    ]

    static let quickAddHelpAccept = "Tap the suggestion (or press Tab) to finish a date or repeat."

    // MARK: Add Task sheet (`task.*`)

    static let addTaskTitle = "Add Task"
    static let fieldTitle = "Title"
    static let titlePlaceholder = "What needs to be done?"
    static let titleRequired = "Title is required"
    static let fieldDescription = "Description"
    static let descriptionPlaceholder = "Add a description…"
    static let fieldStatus = "Status"
    static let fieldPriority = "Priority"
    static let fieldTags = "Tags"
    static let fieldStartDate = "Start date"
    static let fieldDueDate = "Due Date"
    static let fieldProject = "Project"
    static let fieldRepeat = "Repeat"
    static let fieldParent = "Parent task"
    static let createAnother = "Create another"
    static let cancel = "Cancel"
    static let addNoDate = "None"
    static let noParent = "None"
    static let searchTasks = "Search tasks…"
    static let parentThisProject = "This project"
    static let parentOtherProjects = "Other projects"
}
