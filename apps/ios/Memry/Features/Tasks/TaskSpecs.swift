import Foundation

// The Tasks page's view state and the saved-filter shapes, in desktop's JSON
// (`packages/contracts/src/saved-filters-api.ts`), so a filter built here is a
// filter desktop reads and the other way round. The core reads the same JSON
// (`TaskFilters::from_json`), unknown values included.

/// The tabs of the Tasks page (D4).
enum TasksTab: String, CaseIterable, Codable, Sendable, Identifiable {
    case all, today, tomorrow, next7, archived

    var id: String { rawValue }
}

/// List or kanban (`page.viewMode`).
enum TasksViewMode: String, Codable, Sendable {
    case list, kanban
}

/// `DueDateFilter`.
struct DueDateFilterSpec: Codable, Equatable, Sendable {
    /// `any`, `none`, `overdue`, `today`, `tomorrow`, `this-week`,
    /// `next-week`, `this-month`, `custom` (or a newer build's value).
    var type: String = "any"
    var customStart: String?
    var customEnd: String?
}

/// `TaskFilters`, the saved-filter `filters` object.
struct TaskFilterSpec: Codable, Equatable, Sendable {
    var search: String = ""
    var projectIds: [String] = []
    /// `urgent`, `high`, `medium`, `low`, `none`.
    var priorities: [String] = []
    var tags: [String] = []
    var dueDate = DueDateFilterSpec()
    var statusIds: [String] = []
    /// `active`, `completed`, `all`, `archived`.
    var completion: String = "active"
    /// `all`, `repeating`, `one-time`.
    var repeatType: String = "all"
    /// `all`, `with-time`, `without-time`.
    var hasTime: String = "all"

    /// Desktop's `countActiveFilters`.
    var activeCount: Int {
        var count = 0
        if !search.isEmpty { count += 1 }
        if !projectIds.isEmpty { count += 1 }
        if !priorities.isEmpty { count += 1 }
        if !tags.isEmpty { count += 1 }
        if dueDate.type != "any" { count += 1 }
        if !statusIds.isEmpty { count += 1 }
        if completion != "active" { count += 1 }
        if repeatType != "all" { count += 1 }
        if hasTime != "all" { count += 1 }
        return count
    }

    var isActive: Bool { activeCount > 0 }

    var json: String {
        (try? JSONEncoder().encode(self)).flatMap { String(bytes: $0, encoding: .utf8) } ?? "{}"
    }

    init() {}

    /// Tolerant decode: a missing key takes desktop's zod default.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        search = try container.decodeIfPresent(String.self, forKey: .search) ?? ""
        projectIds = try container.decodeIfPresent([String].self, forKey: .projectIds) ?? []
        priorities = try container.decodeIfPresent([String].self, forKey: .priorities) ?? []
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        dueDate = try container.decodeIfPresent(DueDateFilterSpec.self, forKey: .dueDate) ?? DueDateFilterSpec()
        statusIds = try container.decodeIfPresent([String].self, forKey: .statusIds) ?? []
        completion = try container.decodeIfPresent(String.self, forKey: .completion) ?? "active"
        repeatType = try container.decodeIfPresent(String.self, forKey: .repeatType) ?? "all"
        hasTime = try container.decodeIfPresent(String.self, forKey: .hasTime) ?? "all"
    }
}

/// `TaskSort`.
struct TaskSortSpec: Codable, Equatable, Sendable {
    /// `dueDate`, `priority`, `status`, `createdAt`, `title`, `project`,
    /// `completedAt`, `folder`, `note` (or a newer build's value).
    var field: String = "dueDate"
    /// `asc` or `desc`.
    var direction: String = "asc"

    var json: String {
        (try? JSONEncoder().encode(self)).flatMap { String(bytes: $0, encoding: .utf8) } ?? "{}"
    }
}

/// A saved filter's `config`.
struct SavedFilterConfig: Codable, Equatable, Sendable {
    var filters = TaskFilterSpec()
    var sort: TaskSortSpec?
    var starred: Bool?

    var json: String {
        (try? JSONEncoder().encode(self)).flatMap { String(bytes: $0, encoding: .utf8) } ?? "{}"
    }

    static func decode(_ json: String) -> SavedFilterConfig {
        (try? JSONDecoder().decode(SavedFilterConfig.self, from: Data(json.utf8))) ?? SavedFilterConfig()
    }
}

/// Everything the Tasks page remembers between launches: desktop's
/// `tasks-view-state` meaning (tab, view mode, project scope, filters, sort,
/// collapsed groups).
struct TasksViewState: Codable, Equatable, Sendable {
    var tab: TasksTab = .all
    var viewMode: TasksViewMode = .list
    var projectId: String?
    var filters = TaskFilterSpec()
    var sort = TaskSortSpec()
    var collapsedGroups: Set<String> = ["done", "completed"]
    /// Kanban column mode: `status`, `priority`, `dueDate`, `project`, `canonical`.
    var kanbanColumns: String = "status"
}
