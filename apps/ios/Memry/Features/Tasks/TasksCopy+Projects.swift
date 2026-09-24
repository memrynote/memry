import Foundation

// TP052. The project screens' strings, mirroring desktop's English
// `tasks.json` (`phaseF.componentsTasksProjectModal`, `…StatusEditor`,
// `…DeleteProjectDialog`, `project.validation`, `projectHub`, `projectHome`,
// `colors`, `toasts.project*`) and `common.json` (`newProject`, `projects`).

extension TasksCopy {
    /// Namespaced so no other block's copy extension can collide.
    enum Projects {
        // MARK: Projects list

        static let projectsTitle = "Projects"
        static let newProject = "New project"
        static let archivedProjects = "Archived"
        static func archivedAccessibility(_ count: Int, collapsed: Bool) -> String {
            "Archived, \(count) \(count == 1 ? "project" : "projects"), \(collapsed ? "collapsed" : "expanded")"
        }
        static let reorderProjects = "Reorder"
        static let doneReordering = "Done"
        static let editProject = "Edit project"
        static let archiveProject = "Archive project"
        static let unarchiveProject = "Unarchive project"
        static let noProjects = "No projects yet"
        static let inboxLocked = "The Inbox cannot be archived or deleted"
        static let moveUp = "Move up"
        static let moveDown = "Move down"

        static func projectSummary(open: Int, overdue: Int) -> String {
            let tasks = open == 1 ? "1 open task" : "\(open) open tasks"
            return overdue > 0 ? "\(tasks) · \(overdue) overdue" : tasks
        }

        // MARK: Editor (`componentsTasksProjectModal`)

        static let createProject = "Create Project"
        static let editProjectTitle = "Edit Project"
        static let create = "Create"
        static let save = "Save"
        static let cancel = "Cancel"
        static let iconName = "Icon & Name"
        static let selectIcon = "Select icon"
        static let removeIcon = "Remove icon"
        static let iconHint = "Type an emoji to use as the icon"
        static let emojiField = "Emoji"
        static let projectName = "Project name"
        static let color = "Color"
        static let descriptionOptional = "Description (optional)"
        static let descriptionPlaceholder = "Brief description of this project..."
        static let statuses = "Statuses"
        static let statusesHint = "Configure the workflow stages for this project."
        static let deleteProject = "Delete Project"
        static let unsavedChanges = "Unsaved changes"
        static let unsavedChangesBody = "You have unsaved changes. Are you sure you want to discard them?"
        static let discard = "Discard"

        // MARK: Status editor (`componentsTasksStatusEditor`)

        static let changeStatusColor = "Change status color"
        static let statusName = "Status name"
        static let statusType = "Status type"
        static let addStatus = "Add status"
        static let deleteStatus = "Delete status"

        // MARK: Validation (`project.validation`)

        static let nameRequired = "Project name is required"
        static let nameTooLong = "Project name must be 50 characters or less"
        static let minStatuses = "Projects need at least 2 statuses"
        static let needsTodoForNewTasks = "Projects need at least one 'To Do' status for new tasks"
        static let needsDoneForCompletedTasks = "Projects need at least one 'Done' status for completed tasks"
        static let statusNameRequired = "All statuses must have a name"
        static let statusNamesUnique = "Status names must be unique"
        static let needsTodoStatus = "Projects need at least one 'To Do' status"
        static let needsDoneStatus = "Projects need at least one 'Done' status"

        // MARK: Colours (`colors.*`)

        static func colorName(_ id: String) -> String {
            colorNames[id] ?? id
        }

        private static let colorNames: [String: String] = [
            "gray": "Gray", "red": "Red", "orange": "Orange", "yellow": "Yellow",
            "green": "Green", "teal": "Teal", "blue": "Blue", "indigo": "Indigo",
            "purple": "Purple", "pink": "Pink"
        ]

        // MARK: Delete dialog (`componentsTasksDeleteProjectDialog`)

        static func deleteProjectTitle(_ name: String) -> String { "Delete \"\(name)\"?" }

        static func projectHasTasks(_ count: Int) -> String {
            count == 1 ? "This project has 1 task." : "This project has \(count) tasks."
        }

        static let whatToDoWithTasks = "What would you like to do with them?"
        static let moveTasksToInbox = "Move tasks to Inbox"
        static let deleteAllTasks = "Delete all tasks permanently"
        static let projectHasNoTasks = "This project has no tasks and will be permanently deleted."
        static let cannotBeUndone = "This action cannot be undone."

        // MARK: Toasts (`toasts.project*`)

        static let projectCreated = "Project created"
        static let projectUpdated = "Project updated"
        static let projectArchived = "Project archived"
        static let projectUnarchived = "Project restored"
        static let projectDeleted = "Project deleted"

        // MARK: Hub (`projectHub`, `projectHome`)

        static let projectNotFound = "Project not found"
        static let projectActions = "Project actions"
        static let progress = "Progress"
        static let overdue = "Overdue"
        static let hubTasks = "Tasks"
        static let hubDone = "Done"
        static let hubNotes = "Notes"
        static let hubFiles = "Files"
        static let hubEvents = "Events"
        static let pinned = "Pinned"
        static let emptyTasks = "No tasks yet."
        static let emptyNotes = "No notes linked yet."
        static let emptyFiles = "No files linked yet."
        static let emptyEvents = "No events linked yet."
        static let overviewNote = "Overview"
        static let chooseOverviewNote = "Choose overview note"
        static let clearOverview = "Clear overview"
        static let addNote = "Add note"
        static let addFile = "Add file"
        static let pin = "Pin to overview"
        static let unpin = "Unpin"
        static let unlink = "Remove from project"
        static let untitled = "Untitled"
        static let calendarEvent = "Calendar event"
        static let itemMissing = "Not on this device"
        static let searchNotes = "Search notes"
        static let noResults = "No matches"

        static func doneOf(done: Int, total: Int) -> String { "\(done) of \(total) done" }
        static func overdueCount(_ count: Int) -> String { "\(count) overdue" }
        static func openCount(_ count: Int) -> String { "\(count) open" }

        static func percent(_ value: Int) -> String { "\(value)%" }
    }
}
