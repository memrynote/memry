import Foundation

// TP043. The task detail's strings, mirroring desktop's English
// `packages/i18n/src/locales/en/tasks.json` (`task.*`, `drawer.*`,
// `phaseF.componentsTasksDeleteTaskDialog.*`) and `inbox.json`
// (`phaseF.componentsFilingTagAutocomplete.*`) for the tag field. Nested in
// `Detail` so no other block's copy extension can collide with a name here.

extension TasksCopy {
    enum Detail {
        // MARK: Detail chrome (`task.*`)

        static let details = "Task details"
        static let namePlaceholder = "Task name"
        static let status = "Status"
        static let priority = "Priority"
        static let startDate = "Start date"
        static let dueDate = "Due Date"
        static let reminder = "Reminder"
        static let project = "Project"
        static let repeatLabel = "Repeat"
        static let tags = "Tags"
        static let descriptionLabel = "Description"
        static let descriptionPlaceholder = "Add a description…"
        static let deleteTask = "Delete task"
        static let unarchive = "Unarchive task"
        static let noDate = "No date"
        static let noRepeat = "Does not repeat"
        static let done = "Done"
        static let edit = "Edit"
        static let cancel = "Cancel"
        static let close = "Close"

        static func createdOn(_ date: String) -> String { "Created \(date)" }
        static func editedAgo(_ relative: String) -> String { "Edited \(relative)" }
        /// `linked` (tasks.json).
        static let linked = "Linked"
        static func archivedOn(_ date: String) -> String { "Archived \(date)" }

        // MARK: Missing task (FR-061)

        static let taskMissingTitle = "This task is no longer in this vault"
        static let taskMissingDetail = "It was deleted, or it has not synced to this device yet."

        // MARK: Delete dialog (`phaseF.componentsTasksDeleteTaskDialog.*`)

        static let deleteTaskQuestion = "Delete task?"
        static let deleteTaskConfirm = "Delete Task"

        static func deleteConfirmBody(_ title: String) -> String {
            "“\(title)” will be permanently deleted. This action cannot be undone."
        }

        // MARK: Undo toasts (`use-undoable-task-actions.ts` field labels)

        static let statusChanged = "Status changed"
        static let dueDateChanged = "Due date changed"
        static let movedToProject = "Moved to project"

        static func priorityChanged(_ priority: Int64) -> String { "Priority → \(TasksCopy.priorityLabel(priority))" }

        // MARK: Tags (`inbox.json` tag autocomplete)

        static let addTags = "Add tags"
        static let createTag = "Create"
        static let suggestedTags = "Suggested"

        static func removeTag(_ tag: String) -> String { "Remove tag \(tag)" }

        // MARK: Repeat summary

        static let repeatsUnreadable = "Repeating"

        static func repeatSummary(frequency: String, interval: Int64) -> String {
            if interval <= 1 {
                switch frequency {
                case "daily": return "Daily"
                case "weekly": return "Weekly"
                case "monthly": return "Monthly"
                case "yearly": return "Yearly"
                default: return frequency
                }
            }
            let units = ["daily": "days", "weekly": "weeks", "monthly": "months", "yearly": "years"]
            return "Every \(interval) \(units[frequency] ?? frequency)"
        }

        static func repeatDoneCount(_ count: Int64) -> String { "Done: \(count)x" }
        static func repeatEndsAfter(_ count: Int64) -> String { "Ends: After \(count)x" }
        static func repeatEndsOn(_ date: String) -> String { "Ends: \(date)" }
        static let repeatEndsNever = "Ends: Never"

        // MARK: Related (`drawer.*`)

        static let related = "Related"
        static let addRelatedItem = "Add related item"
        static let searchRelated = "Search related…"
        static let noMatchingRelated = "No matching items"
        static let noRelatedAvailable = "No items available"
        static let noRelatedItems = "No related items yet"
        static let relatedItemMissing = "That related item is no longer in this vault."
        static let relatedCanvasElsewhere = "A canvas. Canvases open on your computer."
        static let relatedItemFallback = "item"

        static func removeRelatedItem(_ title: String) -> String { "Remove related item \(title)" }

        static func relatedKind(_ kind: String) -> String {
            switch kind {
            case "file": "File"
            case "journal": "Journal entry"
            case "canvas": "Canvas"
            default: "Note"
            }
        }

        // MARK: Activity (`drawer.activity*`)

        static let activity = "Activity"
        static let activityEmpty = "Nothing recorded yet. Edits to this task appear here."
        static let activityLoading = "Loading activity…"
        static let activityError = "Activity could not be loaded."
        static let activityMore = "Load more"
        static let activityDescription = "Every change to this task, newest first."
        static let activityFilter = "Filter by change type"
        static let activityFilterAll = "All changes"
        static let activityToday = "Today"
        static let activityYesterday = "Yesterday"
        static let activityByYou = "You"
        static let activityBySync = "Another device"
        static let activitySupersededNote = "Replaced by another device"
        static let activityCharsSame = "reworded"
        static let activityEmptyValue = "empty"
        static let activityValueChanged = "changed"
        static let activityUnknownDate = "Undated"

        static func activityShowAll(_ count: Int) -> String { "Show all \(count)" }
        static func activityTitle(_ title: String) -> String { "Activity — \(title)" }
        static func activityRetention(_ days: Int) -> String { "Activity older than \(days) days is removed." }
        static func activityCharsAdded(_ count: Int) -> String { "+\(count) chars" }
        static func activityCharsRemoved(_ count: Int) -> String { "\(count) chars" }
        static func activityFrom(_ value: String) -> String { "from \(value)" }
        static func activityTo(_ value: String) -> String { "to \(value)" }

        /// `drawer.activityAction*`; an unknown action reads as itself.
        static func activityAction(_ action: String) -> String {
            activityActions[action] ?? action
        }

        /// `drawer.activityField*`; an unknown field reads as itself.
        static func activityField(_ field: String) -> String {
            activityFields[field] ?? field
        }

        private static let activityActions: [String: String] = [
            "created": "Created",
            "updated": "Updated",
            "completed": "Completed",
            "uncompleted": "Reopened",
            "moved": "Moved",
            "deleted": "Deleted",
            "superseded": "Replaced"
        ]

        private static let activityFields: [String: String] = [
            "title": "Title",
            "description": "Description",
            "statusId": "Status",
            "priority": "Priority",
            "dueDate": "Due date",
            "dueTime": "Due time",
            "startDate": "Start date",
            "projectId": "Project",
            "parentId": "Parent task",
            "tags": "Tags",
            "linkedNoteIds": "Related items",
            "completedAt": "Completion",
            "archivedAt": "Archive",
            "repeatConfig": "Repeat",
            "sourceNoteId": "Source note",
            "repeatFrom": "Repeat from",
            "isRepeating": "Repeating"
        ]
    }
}
