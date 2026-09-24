import Foundation
import MemryCore

// TP048. The filter sheet's vocabulary: the option lists desktop offers, the
// quick presets (`data/tasks-data.ts` `quickFilterPresets`) and the active
// filter chips (`active-filters-bar.tsx`). None of this narrows a task list —
// the core does that from `TaskFilterSpec` (D5). These are the words and
// shapes of the controls that edit the spec.

/// Desktop's quick filter presets, in desktop's order.
enum TaskFilterPreset: String, CaseIterable, Identifiable, Sendable {
    case overdue
    case highPriority = "high-priority"
    case dueThisWeek = "due-this-week"
    case repeating
    case noDueDate = "no-due-date"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .overdue: "exclamationmark.triangle"
        case .highPriority: "flag"
        case .dueThisWeek: "calendar"
        case .repeating: "repeat"
        case .noDueDate: "questionmark.circle"
        }
    }

    private var priorities: [String]? { self == .highPriority ? ["urgent", "high"] : nil }

    private var dueType: String? {
        switch self {
        case .overdue: "overdue"
        case .dueThisWeek: "this-week"
        case .noDueDate: "none"
        case .highPriority, .repeating: nil
        }
    }

    private var repeatType: String? { self == .repeating ? "repeating" : nil }

    /// `{...defaultFilters, ...preset.filters}`: the preset over a clean spec.
    var filters: TaskFilterSpec {
        var spec = TaskFilterSpec()
        if let priorities { spec.priorities = priorities }
        if let dueType { spec.dueDate = DueDateFilterSpec(type: dueType) }
        if let repeatType { spec.repeatType = repeatType }
        return spec
    }

    /// `QuickFilters.activePresetId`: the preset whose fields match and whose
    /// other fields are at their defaults. Completion is not compared, as on
    /// desktop.
    static func active(in filters: TaskFilterSpec) -> TaskFilterPreset? {
        allCases.first { $0.matches(filters) }
    }

    private func matches(_ filters: TaskFilterSpec) -> Bool {
        var isMatch = true
        if let priorities {
            isMatch = filters.priorities.count == priorities.count
                && priorities.allSatisfy { filters.priorities.contains($0) }
        }
        if let dueType { isMatch = isMatch && filters.dueDate.type == dueType }
        if let repeatType { isMatch = isMatch && filters.repeatType == repeatType }
        guard isMatch else { return false }
        return filters.search.isEmpty
            && filters.projectIds.isEmpty
            && (priorities != nil || filters.priorities.isEmpty)
            && (dueType != nil || filters.dueDate.type == "any")
            && filters.statusIds.isEmpty
            && (repeatType != nil || filters.repeatType == "all")
            && filters.hasTime == "all"
            && filters.tags.isEmpty
    }
}

/// The values each filter control offers, in desktop's order.
enum TaskFilterOptions {
    /// Wire names, most urgent first (`priority-panel.tsx`).
    static let priorities = ["urgent", "high", "medium", "low", "none"]
    /// `dueDateFilterOptions` without `custom`, which has its own control.
    static let dueTypes = ["any", "none", "overdue", "today", "tomorrow", "this-week", "next-week", "this-month"]
    static let completions = ["active", "completed", "all", "archived"]
    static let repeatTypes = ["all", "repeating", "one-time"]
    static let hasTimes = ["all", "with-time", "without-time"]
    /// `group-by-dropdown.tsx` `VISIBLE_FIELDS`.
    static let groupFields = ["priority", "status", "dueDate", "createdAt", "title", "project", "folder", "note"]

    /// The 0-4 integer a priority wire name stands for.
    static func priorityValue(_ name: String) -> Int64 {
        switch name {
        case "urgent": 4
        case "high": 3
        case "medium": 2
        case "low": 1
        default: 0
        }
    }

    static func priorityLabel(_ name: String) -> String {
        priorities.contains(name) ? TasksCopy.priorityLabel(priorityValue(name)) : name
    }

    /// The core's rule (`saved_filters::valid_name`): 1 to 100 UTF-16 units.
    static func isValidSavedFilterName(_ name: String) -> Bool {
        (1 ... 100).contains(name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
    }

    /// A stored custom-range end as a short date. Desktop writes an ISO
    /// instant, iOS a `YYYY-MM-DD` key; both read here.
    static func displayDate(_ text: String) -> String {
        parseDate(text)?.formatted(.dateTime.month(.abbreviated).day()) ?? text
    }

    /// A stored custom-range end as a local date, for the pickers.
    static func parseDate(_ text: String) -> Date? {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return (try? iso.parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text)) ?? TaskDates.date(text)
    }

    /// How a due filter reads, a custom range as its two ends.
    static func dueLabel(_ due: DueDateFilterSpec) -> String {
        if due.type == "custom", let start = due.customStart, let end = due.customEnd {
            return "\(displayDate(start)) – \(displayDate(end))"
        }
        return TasksCopy.dueFilterLabel(due.type)
    }
}

/// One pill in the active filters bar.
struct TaskFilterChip: Identifiable, Equatable, Sendable {
    enum Dimension: String, Sendable {
        case priority, tags, status, project, dueDate, search, completion, repeatType, hasTime
    }

    let dimension: Dimension
    /// "Priority is", or nil for the search pill.
    let prefix: String?
    let value: String

    var id: String { dimension.rawValue }

    /// The spec with this pill's dimension back at its default.
    func cleared(_ filters: TaskFilterSpec) -> TaskFilterSpec {
        var spec = filters
        let clean = TaskFilterSpec()
        switch dimension {
        case .priority: spec.priorities = clean.priorities
        case .tags: spec.tags = clean.tags
        case .status: spec.statusIds = clean.statusIds
        case .project: spec.projectIds = clean.projectIds
        case .dueDate: spec.dueDate = clean.dueDate
        case .search: spec.search = clean.search
        case .completion: spec.completion = clean.completion
        case .repeatType: spec.repeatType = clean.repeatType
        case .hasTime: spec.hasTime = clean.hasTime
        }
        return spec
    }

    /// The pills for a spec, in desktop's order; the completion, repeat and
    /// time pills follow because iOS offers those controls too.
    static func chips(for filters: TaskFilterSpec, projects: [ProjectItem]) -> [TaskFilterChip] {
        var chips: [TaskFilterChip] = []
        if !filters.priorities.isEmpty {
            let names = filters.priorities.map(TaskFilterOptions.priorityLabel).joined(separator: ", ")
            chips.append(TaskFilterChip(dimension: .priority, prefix: TasksCopy.chipPriorityIs, value: names))
        }
        if !filters.tags.isEmpty {
            chips.append(TaskFilterChip(
                dimension: .tags, prefix: TasksCopy.chipTagsIs, value: filters.tags.joined(separator: ", ")
            ))
        }
        if !filters.statusIds.isEmpty {
            let statuses = projects.flatMap(\.statuses)
            let names = filters.statusIds.map { id in statuses.first { $0.id == id }?.name ?? id }
            chips.append(TaskFilterChip(
                dimension: .status, prefix: TasksCopy.chipStatusIs, value: names.joined(separator: ", ")
            ))
        }
        if !filters.projectIds.isEmpty {
            let names = filters.projectIds.compactMap { id in projects.first { $0.id == id }?.name }
            let value = names.isEmpty ? TasksCopy.chipUnknownProject : names.joined(separator: ", ")
            chips.append(TaskFilterChip(dimension: .project, prefix: TasksCopy.chipProjectIs, value: value))
        }
        if filters.dueDate.type != "any" {
            chips.append(TaskFilterChip(
                dimension: .dueDate, prefix: TasksCopy.chipDue, value: TaskFilterOptions.dueLabel(filters.dueDate)
            ))
        }
        if !filters.search.isEmpty {
            chips.append(TaskFilterChip(dimension: .search, prefix: nil, value: "\"\(filters.search)\""))
        }
        if filters.completion != "active" {
            chips.append(TaskFilterChip(
                dimension: .completion,
                prefix: TasksCopy.filterCompletion,
                value: TasksCopy.completionFilterLabel(filters.completion)
            ))
        }
        if filters.repeatType != "all" {
            chips.append(TaskFilterChip(
                dimension: .repeatType, prefix: nil, value: TasksCopy.repeatFilterLabel(filters.repeatType)
            ))
        }
        if filters.hasTime != "all" {
            chips.append(TaskFilterChip(
                dimension: .hasTime, prefix: nil, value: TasksCopy.hasTimeFilterLabel(filters.hasTime)
            ))
        }
        return chips
    }

    /// The dimension's name in "Remove … filter".
    var dimensionName: String {
        switch dimension {
        case .priority: TasksCopy.filterPriority
        case .tags: TasksCopy.filterTags
        case .status: TasksCopy.filterStatus
        case .project: TasksCopy.filterProject
        case .dueDate: TasksCopy.filterDueDate
        case .search: TasksCopy.chipSearch
        case .completion: TasksCopy.filterCompletion
        case .repeatType: TasksCopy.filterRepeat
        case .hasTime: TasksCopy.filterHasTime
        }
    }
}
