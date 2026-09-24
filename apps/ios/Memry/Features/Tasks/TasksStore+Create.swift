import Foundation
import MemryCore

// TP042. Creating tasks: the quick-add submit and the Add Task sheet.
//
// **What is parsed is the core's.** `parseQuickAdd` reads the title, the
// `@date`, `every …`, `!priority`, `+project`, `#tag` and `[[note]]` runs; this
// file only chooses the project the new task lands in (desktop's
// `resolveQuickAddProject`), turns `[[note]]` titles into note ids, and hands
// everything to `create`, which resolves the default status itself.

/// Everything the Add Task sheet edits.
struct TaskDraft: Equatable, Sendable {
    var title = ""
    var description = ""
    var projectId: String?
    /// `nil` lets the core pick the project's default status.
    var statusId: String?
    var parentId: String?
    var priority: Int64 = 0
    var dueDate: String?
    var dueTime: String?
    var startDate: String?
    var rule: RepeatRule?
    var repeatFrom: String?
    var tags: [String] = []
    var linkedNoteIds: [String] = []

    var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// "Create another" (`add-task-modal.tsx`): keep the project, parent and
    /// due date; clear everything the next task would not share.
    mutating func resetForAnother() {
        title = ""
        description = ""
        statusId = nil
        dueTime = nil
        startDate = nil
        priority = 0
        rule = nil
        repeatFrom = nil
        tags = []
        linkedNoteIds = []
    }

    func input(projectId: String) -> NewTaskInput {
        let body = description.trimmingCharacters(in: .whitespacesAndNewlines)
        return NewTaskInput(
            title: trimmedTitle,
            projectId: projectId,
            statusId: statusId,
            parentId: parentId,
            priority: priority,
            description: body.isEmpty ? nil : body,
            dueDate: dueDate,
            dueTime: dueDate == nil ? nil : dueTime,
            startDate: startDate,
            repeat: rule,
            repeatFrom: rule == nil ? nil : repeatFrom,
            tags: tags,
            linkedNoteIds: linkedNoteIds,
            linkedCanvasIds: [],
            sourceNoteId: nil,
            position: nil
        )
    }
}

/// What the quick-add lists handed out, so submit links the note or project
/// the user actually picked rather than re-resolving a title two may share
/// (desktop's `pickedNoteIdsRef`).
struct QuickAddPicks: Equatable, Sendable {
    /// Lowercased note title to note id.
    var notes: [String: String] = [:]
    /// Lowercased `+marker` text (without the `+`) to project id.
    var projects: [String: String] = [:]
}

extension TasksStore {
    // MARK: Project resolution

    /// Where a new task lands, `resolveQuickAddProject` in order: the parsed
    /// `+project`, the surface's own project (a project hub), the scope
    /// picker's project, the settings default, the Inbox, then the first
    /// project. A stored id that no longer names a live project is skipped
    /// rather than written into a task.
    func resolveProjectId(parsed: String?, preferred: String? = nil) -> String? {
        let live = projects.filter { $0.archivedAt == nil }
        let exists = { (id: String?) -> String? in
            guard let id, live.contains(where: { $0.id == id }) else { return nil }
            return id
        }
        if let parsed, projects.contains(where: { $0.id == parsed }) { return parsed }
        return exists(preferred)
            ?? exists(state.projectId)
            ?? exists(settings?.defaultProjectId)
            ?? live.first(where: \.isInbox)?.id
            ?? live.first?.id
    }

    /// The due date a new task starts with when none was typed: today on the
    /// Today tab (desktop's `modalDefaultDueDate` and quick-add fallback).
    func defaultDueDate() -> String? {
        state.tab == .today ? today() : nil
    }

    /// The Add Task sheet's opening draft: a subtask lands in its parent's
    /// project, anything else where quick add would put it; due today on
    /// the Today tab.
    func newTaskDraft(title: String, parentId: String?, projectId: String?) -> TaskDraft {
        var draft = TaskDraft()
        draft.title = title
        draft.parentId = parentId
        let parentProject = parentId.flatMap { items[$0]?.projectId }
        draft.projectId = parentProject ?? resolveProjectId(parsed: nil, preferred: projectId)
        draft.dueDate = defaultDueDate()
        return draft
    }

    /// Top-level, open, unarchived tasks a new task can be filed under.
    func parentCandidates() -> [TaskItem] {
        ordered.filter { $0.parentId == nil && $0.archivedAt == nil && !$0.isDone }
    }

    // MARK: Creating

    /// Creates the drafted task; returns its id. Undoable ("Task created").
    @discardableResult
    func createTask(_ draft: TaskDraft) async -> String? {
        guard !draft.trimmedTitle.isEmpty,
              let projectId = draft.projectId ?? resolveProjectId(parsed: nil) else { return nil }
        let input = draft.input(projectId: projectId)
        let change = await perform(TasksCopy.created) { try $0.create(input: input) }
        return change?.created.first
    }

    // MARK: Quick add

    /// The core's reading of the quick-add text.
    func parseQuickAdd(_ text: String) async -> QuickAddParse? {
        let now = localNow()
        return await read { try $0.parseQuickAdd(input: text, now: now) }
    }

    /// Parses and creates in one step; returns the new id, or `nil` when the
    /// text holds no title or no project resolves.
    @discardableResult
    func submitQuickAdd(_ text: String, preferredProjectId: String?, picks: QuickAddPicks) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let parsed = await parseQuickAdd(trimmed) else { return nil }
        let title = parsed.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        let picked = pickedProjectId(in: trimmed, picks: picks)
        guard let projectId = resolveProjectId(parsed: picked ?? parsed.projectId, preferred: preferredProjectId)
        else { return nil }
        var draft = TaskDraft()
        draft.title = title
        draft.projectId = projectId
        draft.priority = parsed.priority
        draft.dueDate = parsed.dueDate ?? defaultDueDate()
        draft.dueTime = parsed.dueDate == nil ? nil : parsed.dueTime
        draft.rule = parsed.repeat
        draft.tags = parsed.tags
        draft.linkedNoteIds = await noteIds(for: parsed.noteTitles, picks: picks)
        return await createTask(draft)
    }

    /// A project the list handed out whose `+marker` is still in the text.
    private func pickedProjectId(in text: String, picks: QuickAddPicks) -> String? {
        let words = text.lowercased().split(whereSeparator: \.isWhitespace)
        return words.lazy
            .filter { $0.hasPrefix("+") }
            .compactMap { picks.projects[String($0.dropFirst())] }
            .first
    }

    /// `[[Title]]` runs as note ids: what the picker handed out, else an
    /// exact (case-insensitive) title match from the related-item search.
    /// An unmatched title links nothing, as on desktop.
    func noteIds(for titles: [String], picks: QuickAddPicks) async -> [String] {
        var ids: [String] = []
        for title in titles {
            let key = title.lowercased()
            if let id = picks.notes[key] {
                ids.append(id)
                continue
            }
            let found = await read { try $0.searchRelated(query: title, limit: 20) }
            if let match = found?.first(where: { $0.kind == "note" && $0.title.lowercased() == key }) {
                ids.append(match.id)
            }
        }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }

    // MARK: Suggestions

    /// Live projects whose name or id contains `query` (`getProjectOptions`).
    func projectSuggestions(_ query: String) -> [ProjectItem] {
        let lower = query.lowercased()
        return projects
            .filter { $0.archivedAt == nil }
            .filter { lower.isEmpty || $0.name.lowercased().contains(lower) || $0.id.lowercased().contains(lower) }
    }

    /// The vault's task tags, commonest first, containing `query`
    /// (`useTagSuggestions` + `getTagOptions`).
    func tagSuggestions(_ query: String) -> [String] {
        var counts: [String: Int] = [:]
        for task in ordered {
            for tag in task.tags { counts[tag, default: 0] += 1 }
        }
        let lower = query.lowercased()
        return counts
            .filter { lower.isEmpty || $0.key.lowercased().contains(lower) }
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map(\.key)
    }

    /// Notes for the `[[` picker, best first (the related-item search).
    func noteSuggestions(_ query: String, limit: UInt32 = 10) async -> [RelatedItemRecord] {
        let found = await read { try $0.searchRelated(query: query, limit: limit) } ?? []
        return found.filter { $0.kind == "note" }
    }
}

extension ProjectItem {
    /// The `+marker` for this project: the name, spaces as dashes, which the
    /// core reads back as the kebab-case name (`findProjectByName`).
    var quickAddMarker: String {
        name.split(whereSeparator: \.isWhitespace).joined(separator: "-")
    }
}
