import Foundation

// TP033. The strings the task screens share, mirroring desktop's English
// `packages/i18n/src/locales/en/tasks.json` (and `common.json` for recurrence).
//
// **Literals, not a catalogue** (§5 of the plan; spec-defect 98): every iOS
// screen keeps its copy in a `*Copy` value so a test can assert which sentence
// a state produced. A feature screen adds its own strings in an extension of
// ``TasksCopy`` in its own file, so no two screens edit this one.

enum TasksCopy {
    // MARK: Tabs (`page.tabs.*`)

    static let tabsLabel = "Task views"
    static let tabAll = "All"
    static let tabToday = "Today"
    static let tabTomorrow = "Tomorrow"
    static let tabNext7 = "Next 7 days"
    static let tabArchived = "Archived"

    static func tabTitle(_ tab: TasksTab) -> String {
        switch tab {
        case .all: tabAll
        case .today: tabToday
        case .tomorrow: tabTomorrow
        case .next7: tabNext7
        case .archived: tabArchived
        }
    }

    // MARK: Page chrome

    static let title = "Tasks"
    static let viewModeLabel = "View mode"
    static let listView = "List view"
    static let kanbanView = "Kanban view"
    static let allProjects = "All projects"
    static let searchProjects = "Search projects…"
    static let addTask = "Add task"
    static let loading = "Loading…"

    // MARK: Priorities (`task.priorityLabels.*`)

    static func priorityLabel(_ value: Int64) -> String {
        switch value {
        case 4: "Urgent"
        case 3: "High"
        case 2: "Medium"
        case 1: "Low"
        default: "No Priority"
        }
    }

    // MARK: Status types

    static func statusTypeLabel(_ type: String?) -> String {
        switch type {
        case "done": "Done"
        case "in_progress": "In Progress"
        default: "To Do"
        }
    }

    // MARK: Group label keys (`filtering/grouping.ts`)

    /// The label for a group key the core returns. User-data groups carry a
    /// name instead and never reach this.
    static func groupLabel(_ key: String) -> String {
        groupLabels[key] ?? key
    }

    private static let groupLabels: [String: String] = [
        "dueDate.overdue": "Overdue",
        "dueDate.today": "Today",
        "dueDate.tomorrow": "Tomorrow",
        "dueDate.upcoming": "This Week",
        "dueDate.later": "Later",
        "dueDate.noDueDate": "No Due Date",
        "priority.urgent": "Urgent",
        "priority.high": "High",
        "priority.medium": "Medium",
        "priority.low": "Low",
        "priority.none": "No Priority",
        "project.none": "No Project",
        "createdAt.today": "Today",
        "createdAt.yesterday": "Yesterday",
        "createdAt.thisWeek": "This Week",
        "createdAt.earlier": "Earlier",
        "status.todo": "To Do",
        "status.in_progress": "In Progress",
        "status.done": "Done",
        "status.uncategorized": "Uncategorized",
        "folder.vaultRoot": "Vault root",
        "note.none": "No note"
    ]

    // MARK: Toasts (`toasts.*`)

    static let undo = "Undo"
    static let completed = "Task completed!"
    static let seriesComplete = "Series complete!"
    static let deleted = "Task deleted"
    static let archived = "Task archived"
    static let created = "Task created"
    static let updated = "Task updated"

    static func nextOccurrence(_ date: String) -> String { "Next occurrence: \(date)" }

    static func bulkCompleted(_ count: Int) -> String {
        count == 1 ? "1 task completed" : "\(count) tasks completed"
    }

    // MARK: Sync

    static let syncing = "Syncing…"
}
