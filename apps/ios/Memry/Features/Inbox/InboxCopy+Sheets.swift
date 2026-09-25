import Foundation

// Copy for the File, Convert, Tag and select-mode surfaces (`detail.*`,
// `bulk.*`, `convert.*`, `phaseF.componentsFiling*`).

extension InboxCopy {
    // MARK: File sheet (Paper 13)

    static let searchOrCreate = "Search or create with /"
    static let allFolders = "All folders"
    static let tags = "Tags"
    static let addTag = "Add tag"
    static let addTagsPlaceholder = "Add tags..."
    static let linkToNotes = "Link to notes"
    static let findOrCreateNote = "Find or create a note..."
    static func createFolder(_ name: String) -> String { "Create “\(name)”" }
    static func createNote(_ title: String) -> String { "Create “\(title)”" }
    static let newNote = "New note"
    static let imageLandsAs = "Image lands as"
    static let imageEmbed = "Embedded in the note"
    static let imageLink = "File in the sidebar"
    static let dontAskAgain = "Don't ask again"
    static let embedNeedsNote = "Embedding needs a linked note."
    static let bulkNoLinks = "Links to other notes cannot be added when filing multiple items."
    static func fileItems(_ count: Int) -> String { count == 1 ? "File 1 item" : "File \(count) items" }
    static func removeLink(_ title: String) -> String { "Remove link to \(title)" }
    static func removeTag(_ tag: String) -> String { "Remove tag \(tag)" }
    static let noFolders = "No folders found"

    // MARK: Convert (Paper 14, 15)

    static let dueDate = "Due date"
    static let dueTime = "Due time"
    static let priority = "Priority"
    static let project = "Project"
    static let inboxProject = "Inbox"
    static let remindMe = "Remind me"
    static let remindAt = "Remind me at"
    static let time = "Time"
    static let none = "None"
    static let convertFooter = "Creates the task and marks this capture as processed. Note goes back to the File sheet."
    static let reminderFooter = "Creates a note from this capture and reminds you about it."
    static let noteFooter = "Creates a note at the top of your notes from this capture."
    static let addTask = "Add task"
    static let setReminder = "Set reminder"
    static let createNoteAction = "Create note"

    static func priorityName(_ value: Int64) -> String {
        switch value {
        case 1: "Low"
        case 2: "Medium"
        case 3: "High"
        case 4: "Urgent"
        default: "None"
        }
    }

    // MARK: Select mode (Paper 16, `bulk.*`)

    static let tag = "Tag"
    static func archiveDialogTitle(_ count: Int) -> String { count == 1 ? "Archive 1 item?" : "Archive \(count) items?" }
    static func archiveDialogConfirm(_ count: Int) -> String { count == 1 ? "Archive 1 item" : "Archive \(count) items" }
    static let archiveDialogBody = "These items will be archived. You can view archived items later."
    static func tagItems(_ count: Int) -> String { count == 1 ? "Tag 1 item" : "Tag \(count) items" }
    static func applyTo(_ count: Int) -> String { count == 1 ? "Apply to 1 item" : "Apply to \(count) items" }
}
