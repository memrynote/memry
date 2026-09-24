import Foundation

// RD01–RD20. Strings the Paper redesign adds (title menu, subtitle, the …
// menu, the floating "+", select mode, the composer). Desktop wording where
// `packages/i18n/src/locales/en/tasks.json` has one: "Group by", "Completed",
// "Select", "Move to", "Clear all", "Notes", "Linked", "Add subtask",
// "Statuses", "Start date", "Parent task", "Repeat".

extension TasksCopy {
    // MARK: Subtitle

    static func subtitleTasks(_ count: Int) -> String { count == 1 ? "1 task" : "\(count) tasks" }
    static func subtitleDone(_ done: Int, of total: Int) -> String { "\(done) of \(total) done" }
    static func subtitleArchived(_ count: Int) -> String { "\(count) archived" }
    static let subtitleFiltered = "Filtered"
    static func subtitleColumns(_ mode: KanbanColumnMode) -> String { "By \(kanbanModeLabel(mode).lowercased())" }
    static let subtitleSeparator = " · "

    // MARK: Title menu (artboard 02)

    static let titleMenuViews = "Views"
    static let titleMenuProject = "Project"
    static let titleMenuSearchProjects = "Search projects…"
    static let titleMenuStarred = "Starred views"
    static let titleMenuHint = "Shows the views, the project scope and starred filters"

    // MARK: … menu (artboard 12)

    static let moreMenuLabel = "View options"
    static let moreList = "List"
    static let moreBoard = "Board"
    static let moreSelect = "Select"
    static let moreGroupBy = "Group by"
    static let moreSort = "Sort"
    static let moreColumns = "Columns"
    static let moreShowCompleted = "Show completed"
    static let moreTaskSettings = "Task settings"
    static let sortAscending = "Ascending"
    static let sortDescending = "Descending"

    // MARK: Groups

    /// The Done section (`completedAt` group label on desktop).
    static let completedGroup = "Completed"

    // MARK: Add

    static let addButtonHint = "Opens the task composer"

    // MARK: Select mode (artboard 14)

    static let selectTasks = "Select tasks"
    static let selectDoneLabel = "Done selecting"

    static func selectDragHint(_ count: Int) -> String {
        switch count {
        case 0: "Tap tasks to select them"
        case 1: "Drag the selected row to move it"
        default: "Drag a selected row to move all \(count)"
        }
    }

    static let bulkDate = "Date"
    static let bulkMove = "Move"
    static let bulkMore = "More"

    // MARK: Composer (artboards 03–04)

    static let composerLabel = "New task"
    static let composerTitlePlaceholder = "New task"
    static let composerNotes = "Notes"
    static let composerDate = "Date"
    static let composerNoProject = "No project"
    static let composerNewTag = "New tag…"
    static let composerReminder = "Reminder"
    static let composerNoReminder = "No reminder"
    static let composerMoreFields = "More fields…"
    static let composerMore = "More properties"
    static let composerClose = "Close composer"

    static func composerDateLabel(_ value: String?) -> String {
        value.map { "Date: \($0)" } ?? "Date: none"
    }

    static func composerPriorityLabel(_ value: Int64) -> String { "Priority: \(priorityLabel(value))" }

    static func composerProjectLabel(_ name: String?) -> String { "Project: \(name ?? composerNoProject)" }

    static func composerTags(_ tags: [String]) -> String {
        guard let first = tags.first else { return "#" }
        return tags.count == 1 ? "#\(first)" : "#\(first) +\(tags.count - 1)"
    }

    static func composerTagsLabel(_ tags: [String]) -> String {
        tags.isEmpty ? "Tags: none" : rowTags(tags)
    }

    // MARK: Empty Today (artboard 20)

    static func nextViewHint(_ count: Int, view: String) -> String {
        "\(subtitleTasks(count)) due \(view.lowercased())."
    }

    static func showView(_ view: String) -> String { "Show \(view.lowercased())" }
}
