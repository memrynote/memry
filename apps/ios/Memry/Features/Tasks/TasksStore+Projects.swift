import MemryCore
import SwiftUI

// TP052. Project writes and hub reads over the core (D2: projects are fully
// writable on the phone). Every rule — status reconciliation, the Inbox that
// cannot be archived or deleted, moving tasks on delete, a markdown note's
// `project` property on link/unlink — is the core's; this file only runs the
// calls, reports failures through the store and says what the toast shows.
//
// None of these writes returns a `TaskChange`, so none is undoable: desktop
// offers no undo for project edits either.

extension TasksStore {
    // MARK: Lists

    /// Live, non-archived projects in `position` order (Inbox included).
    var activeProjects: [ProjectItem] {
        projects.filter { $0.archivedAt == nil }
    }

    /// Archived projects in `position` order.
    var archivedProjects: [ProjectItem] {
        projects.filter { $0.archivedAt != nil }
    }

    /// Task counts per project id, archived projects included.
    func projectStatsById() async -> [String: ProjectStats] {
        let today = today()
        let stats = await read { try $0.projectStats(includeArchived: true, today: today) } ?? []
        return Dictionary(stats.map { ($0.projectId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: Writes

    /// Creates a project; returns its id.
    @discardableResult
    func createProject(_ draft: ProjectDraft) async -> String? {
        let id = await run { try $0.createProject(draft: draft) }
        if id != nil { toast = TasksCopy.Projects.projectCreated }
        return id
    }

    /// Saves the editor. Returns whether the core accepted it.
    @discardableResult
    func updateProject(_ id: String, draft: ProjectDraft) async -> Bool {
        let saved = await run { try $0.updateProject(id: id, draft: draft) } != nil
        if saved { toast = TasksCopy.Projects.projectUpdated }
        return saved
    }

    func setProjectArchived(_ id: String, archived: Bool) async {
        let done = await run { try $0.setProjectArchived(id: id, archived: archived) } != nil
        guard done else { return }
        if archived, state.projectId == id {
            await update { $0.projectId = nil }
        }
        toast = archived ? TasksCopy.Projects.projectArchived : TasksCopy.Projects.projectUnarchived
    }

    /// Writes the active projects' new order, then the archived ones after
    /// them, so every project keeps a distinct position.
    func reorderProjects(_ activeIds: [String]) async {
        let ids = activeIds + archivedProjects.map(\.id).filter { !activeIds.contains($0) }
        await run { try $0.reorderProjects(ids: ids) }
    }

    /// Moves active projects the way `List.onMove` reports it.
    func moveProjects(from source: IndexSet, to destination: Int) async {
        var ids = activeProjects.map(\.id)
        ids.move(fromOffsets: source, toOffset: destination)
        await reorderProjects(ids)
    }

    /// Deletes a project, its tasks moved to the Inbox or deleted.
    @discardableResult
    func deleteProject(_ id: String, moveTasksToInbox: Bool) async -> Bool {
        let deleted = await run {
            try $0.deleteProject(id: id, moveTasksToInbox: moveTasksToInbox)
        } != nil
        guard deleted else { return false }
        if state.projectId == id {
            await update { $0.projectId = nil }
        }
        toast = TasksCopy.Projects.projectDeleted
        return true
    }

    // MARK: Hub

    /// The hub's links in `position` order, or `nil` when the read failed.
    func projectLinks(_ id: String) async -> [ProjectLinkItem]? {
        await read { try $0.projectLinks(id: id) }
    }

    /// The project's tasks as the core's `all` view scopes them: open rows
    /// (subtasks riding with their parents) and the Done section.
    func projectTasks(_ id: String) async -> TaskViewResult? {
        let query = TaskViewQuery(
            tab: TasksTab.all.rawValue,
            projectId: id,
            filtersJson: nil,
            sortJson: TaskSortSpec().json,
            now: localNow(),
            weekStartsOn: weekStartsOn
        )
        return await read { try $0.view(query: query) }
    }

    /// Notes and files to offer in a picker (`searchRelated`), best first.
    func searchLinkable(_ query: String, limit: UInt32 = 20) async -> [RelatedItemRecord] {
        await read { try $0.searchRelated(query: query, limit: limit) } ?? []
    }

    /// Titles for the notes and files a hub shows, keyed by id. The core has
    /// no per-id resolver for project links, so this reads every live note
    /// and file the picker could offer (`searchRelated` with an empty query)
    /// and keys them by id.
    func linkableTitles() async -> [String: RelatedItemRecord] {
        let all = await searchLinkable("", limit: UInt32.max)
        return Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Links a picked note or file.
    func link(_ item: RelatedItemRecord, to projectId: String) async {
        let type = ProjectLinkKind(relatedKind: item.kind).itemType
        let itemId = item.id
        await run { try $0.linkToProject(id: projectId, itemType: type, itemId: itemId) }
    }

    func unlink(_ link: ProjectLinkItem, from projectId: String) async {
        await run { try $0.unlinkFromProject(id: projectId, itemType: link.itemType, itemId: link.itemId) }
    }

    func setPinned(_ link: ProjectLinkItem, pinned: Bool, in projectId: String) async {
        await run { try $0.setProjectLinkPinned(id: projectId, itemId: link.itemId, pinned: pinned) }
    }

    func setHomeNote(_ noteId: String?, for projectId: String) async {
        await run { try $0.setProjectHomeNote(id: projectId, noteId: noteId) }
    }
}

/// The three kinds a hub link may point at (`ProjectLinkItemSchema`), plus a
/// newer build's kind, which still lists and unlinks.
enum ProjectLinkKind: Equatable, Sendable {
    case note, file, event, other

    init(itemType: String) {
        switch itemType {
        case "note": self = .note
        case "file": self = .file
        case "calendar_event": self = .event
        default: self = .other
        }
    }

    /// A picked related item: files link as `file`, everything else a note.
    init(relatedKind: String) {
        self = relatedKind == "file" ? .file : .note
    }

    var itemType: String {
        switch self {
        case .note, .other: "note"
        case .file: "file"
        case .event: "calendar_event"
        }
    }
}
