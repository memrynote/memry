import Foundation

// TP040 / TP050. The task list's strings, mirroring desktop's English
// `packages/i18n/src/locales/en/tasks.json` (`page.*`, `filters.*`,
// `phaseF.componentsTasks*EmptyState.*`, `toasts.drag.*`).

extension TasksCopy {
    // MARK: Toolbar

    static let filter = "Filter"
    static let projects = "Projects"
    static let settings = "Settings"
    static let more = "More"
    static let select = "Select"
    static let done = "Done"
    static let activeFilterCount = "active filters"
    static let dismissError = "Dismiss"
    static let moveUp = "Move up"
    static let moveDown = "Move down"

    static func tabAccessibility(_ tab: TasksTab, count: UInt32) -> String {
        "\(tabTitle(tab)), \(count)"
    }

    // MARK: Project scope (`page.projectScope.*`)

    static let projectScope = "Project"
    static let starredFilters = "Starred filters"
    static let noProjects = "No projects yet"

    static func editProject(_ name: String) -> String { "Edit \(name)" }

    // MARK: Groups

    static let doneGroup = "Done"
    static let overdueGroup = "Overdue"

    static func groupAccessibility(_ label: String, count: Int, collapsed: Bool) -> String {
        "\(label), \(count) \(count == 1 ? "task" : "tasks"), \(collapsed ? "collapsed" : "expanded")"
    }

    static let expandHint = "Shows or hides the tasks in this group"
    static let dropHint = "Drop tasks here to reschedule them"

    // MARK: Today progress

    static func todayProgress(done: Int, total: Int) -> String {
        "\(done) of \(total) done today"
    }

    static let allCaughtUp = "All caught up for today"
    static let complete = "Complete"

    // MARK: Empty states (`phaseF.componentsTasks*EmptyState.*`)

    static let allEmptyTitle = "No tasks yet"
    static let allEmptyDescription = "Create your first task to get started"
    static let addTaskButton = "Add Task"
    static let todayEmptyTitle = "All caught up for today"
    static let todayEmptyDescription = "You have nothing scheduled. Enjoy the clarity."
    static let addTaskForToday = "Add task for today"
    static let tomorrowEmptyTitle = "No tasks scheduled"
    static let addTaskForTomorrow = "Add task for tomorrow"
    static let next7EmptyTitle = "No upcoming tasks"
    static let next7EmptyDescription =
        "Tasks due in the next 7 days will appear here. Plan your week by adding some tasks."
    static let addTaskShort = "Add task"
    static let projectEmptyDescription = "Add a task to get started"

    static func projectEmptyTitle(_ name: String) -> String { "No tasks in \(name)" }

    // MARK: Filter empty state (`filters.empty*`)

    static let filtersEmptyTitle = "No tasks match your filters"
    static let filtersEmptyHelp = "Try adjusting your filters or"
    static let clearAllFilters = "Clear all filters"

    // MARK: Drag (`toasts.drag.*`)

    static func rescheduled(count: Int, target: String) -> String {
        count == 1 ? "Rescheduled to \(target)" : "\(count) tasks rescheduled to \(target)"
    }

    /// `dueBucketToDate` labels.
    static func dueBucketLabel(_ bucket: String) -> String {
        switch bucket {
        case "today": "Today"
        case "tomorrow": "Tomorrow"
        case "upcoming": "This Week"
        case "later": "Later"
        default: "No Due Date"
        }
    }
}
