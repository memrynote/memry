import Foundation

// TP048. The filter sheet's, the active chips' and the saved filters' strings,
// from desktop's `tasks.json` (`filters.*`, `phaseF.componentsTasksFilters*`,
// `toasts.filter*`). The completion, repeat and time labels have no desktop
// panel to copy (desktop filters them but offers no picker), so they reuse the
// nearest desktop words.

extension TasksCopy {
    // MARK: Sheet chrome

    static let filterTitle = "Filter"
    static let filterDone = "Done"
    static let filterClear = "Clear"
    static let filterClearAll = "Clear all"
    static let filterClearAllLabel = "Clear all filters"
    static let filterSearchPlaceholder = "Search tasks"
    static let filterClearSearch = "Clear search"
    static let filterQuickFilters = "Quick filters"
    static let filterBy = "Filter by"
    static let filterAny = "Any"

    // MARK: Dimensions

    static let filterProject = "Project"
    static let filterPriority = "Priority"
    static let filterTags = "Tags"
    static let filterDueDate = "Due date"
    static let filterStatus = "Status"
    static let filterCompletion = "Show"
    static let filterRepeat = "Repeat"
    static let filterHasTime = "Time"
    static let filterPickAProject = "Pick a project"
    static let filterNoTags = "No tags yet"
    static let filterNoStatuses = "This project has no statuses"
    static let filterSearchTags = "Search…"

    static func filterSelectedCount(_ count: Int) -> String { "\(count) selected" }

    // MARK: Due date (`filters.dueDate.*`)

    static let filterCustomRange = "Custom range"
    static let filterRangeStart = "From"
    static let filterRangeEnd = "To"
    static let filterApplyRange = "Apply"

    static func dueFilterLabel(_ type: String) -> String {
        switch type {
        case "any": "Any due date"
        case "none": "No due date"
        case "overdue": "Overdue"
        case "today": "Today"
        case "tomorrow": "Tomorrow"
        case "this-week": "This week"
        case "next-week": "Next week"
        case "this-month": "This month"
        case "custom": "Custom range"
        default: type
        }
    }

    // MARK: Completion, repeat, time

    static func completionFilterLabel(_ value: String) -> String {
        switch value {
        case "active": "Active"
        case "completed": "Completed"
        case "all": "All"
        case "archived": "Archived"
        default: value
        }
    }

    static func repeatFilterLabel(_ value: String) -> String {
        switch value {
        case "repeating": "Repeating"
        case "one-time": "One-time"
        case "all": filterAny
        default: value
        }
    }

    static func hasTimeFilterLabel(_ value: String) -> String {
        switch value {
        case "with-time": "Has time set"
        case "without-time": "No time set"
        case "all": filterAny
        default: value
        }
    }

    // MARK: Quick presets (`filters.quickPresets.*`)

    static func presetLabel(_ preset: TaskFilterPreset) -> String {
        switch preset {
        case .overdue: "Overdue"
        case .highPriority: "High Priority"
        case .dueThisWeek: "Due This Week"
        case .repeating: "Repeating"
        case .noDueDate: "No Due Date"
        }
    }

    // MARK: Group by (`filters.groupBy*`)

    static let filterGroupBy = "Group by"
    static let filterSortDirection = "Direction"
    static let filterSortAscending = "Ascending"
    static let filterSortDescending = "Descending"

    static func filterSortFieldLabel(_ field: String) -> String {
        switch field {
        case "dueDate": "Due date"
        case "priority": "Priority"
        case "status": "Status"
        case "createdAt": "Created"
        case "title": "Title"
        case "project": "Project"
        case "completedAt": "Completed"
        case "folder": "Folder"
        case "note": "Note"
        default: field
        }
    }

    static func filterGroupToggleLabel(_ name: String, collapsed: Bool) -> String {
        collapsed ? "\(name), collapsed" : "\(name), expanded"
    }

    static func filterGroupToggleHint(collapsed: Bool) -> String {
        collapsed ? "Expands the group" : "Collapses the group"
    }

    // MARK: Active chips (`componentsTasksFiltersActiveFiltersBar`)

    static let chipPriorityIs = "Priority is"
    static let chipTagsIs = "Tags is"
    static let chipStatusIs = "Status is"
    static let chipProjectIs = "Project is"
    static let chipDue = "Due"
    static let chipSearch = "Search"
    static let chipUnknownProject = "Unknown"
    static let chipsLabel = "Active filters"

    static func chipRemoveLabel(_ dimension: String) -> String { "Remove \(dimension) filter" }

    // MARK: Saved filters

    static let filterSavedTitle = "Saved filters"
    static let saveFilter = "Save Filter"
    static let saveCurrentFilter = "Save current filter"
    static let saveFilterSetFirst = "Set filters first"
    static let saveFilterMessage = "Save your current filter settings for quick access later."
    static let saveFilterName = "Filter Name"
    static let saveFilterPlaceholder = "e.g., High priority this week"
    static let saveFilterNameRule = "A filter name is 1 to 100 characters."
    static let saveChip = "Save"
    static let savedChip = "Saved"
    static let filterCancel = "Cancel"
    static let renameFilter = "Rename"
    static let renameFilterTitle = "Rename Filter"
    static let deleteFilter = "Delete"
    static let reorderFilters = "Reorder saved filters"
    static let noSavedFilters = "No saved filters yet"

    static func starFilterLabel(_ name: String, starred: Bool) -> String {
        starred ? "Unstar \(name)" : "Star \(name)"
    }

    static func savedFilterHint(active: Bool) -> String {
        active ? "Clears this filter" : "Applies this filter"
    }

    // MARK: Toasts (`toasts.filter*`)

    static let filterSaved = "Filter saved"
    static let filterDeleted = "Filter deleted"
    static let filtersCleared = "Filters cleared"

    static func filterApplied(_ name: String) -> String { "Applied \"\(name)\"" }
}
