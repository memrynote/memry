import MemryCore
import SwiftUI

// TP043. The task detail's writes and reads. Every field edit is one core call
// through `perform`, so the core applies the rule (a done status stamps
// `completedAt`, a project move resolves the equivalent status and carries the
// subtasks) and the store refreshes from the answer.
//
// **Which edits are undoable follows desktop** (`use-undoable-task-actions.ts`
// `UNDOABLE_FIELDS`): priority, status, due date/time, project and archive
// raise an Undo toast; title, description, tags, start date, repeat and
// related items do not.
//
// Method names carry a `detail` prefix so no other block's store extension can
// collide with them.

/// Desktop's activity page sizes (`task-activity-query-keys.ts`).
enum TaskActivityPaging {
    static let preview: UInt32 = 3
    static let page: UInt32 = 50
    /// `TASK_ACTIVITY_RETENTION_DAYS` (`packages/db-schema`).
    static let retentionDays = 90
}

extension TasksStore {
    // MARK: Fields

    /// Renames a task. A blank or unchanged title is dropped (a task cannot be
    /// untitled, desktop #1991). Returns whether a write ran.
    @discardableResult
    func detailRename(_ task: TaskItem, to title: String) async -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != task.title else { return false }
        let id = task.id
        return await perform(nil) { try $0.setTitle(id: id, title: trimmed) } != nil
    }

    func detailSetStatus(_ task: TaskItem, statusId: String) async {
        guard statusId != task.statusId else { return }
        let id = task.id
        await perform(TasksCopy.Detail.statusChanged) { try $0.setStatus(id: id, statusId: statusId) }
    }

    func detailSetPriority(_ task: TaskItem, _ priority: Int64) async {
        guard priority != task.priority else { return }
        let id = task.id
        await perform(TasksCopy.Detail.priorityChanged(priority)) {
            try $0.setPriority(id: id, priority: priority)
        }
    }

    /// Sets or clears the due date and time (`nil` clears).
    func detailSetDue(_ task: TaskItem, date: String?, time: String?) async {
        guard date != task.dueDate || time != task.dueTime else { return }
        let id = task.id
        await perform(TasksCopy.Detail.dueDateChanged) { try $0.setDue(id: id, date: date, time: time) }
    }

    func detailSetStartDate(_ task: TaskItem, date: String?) async {
        guard date != task.startDate else { return }
        let id = task.id
        await perform(nil) { try $0.setStartDate(id: id, date: date) }
    }

    func detailMove(_ task: TaskItem, toProject projectId: String) async {
        guard projectId != task.projectId else { return }
        let id = task.id
        await perform(TasksCopy.Detail.movedToProject) { try $0.setProject(id: id, projectId: projectId) }
    }

    func detailSetRepeat(_ task: TaskItem, rule: RepeatRule?, repeatFrom: String?) async {
        let id = task.id
        await perform(nil) { try $0.setRepeat(id: id, rule: rule, repeatFrom: repeatFrom) }
    }

    /// Saves the description when it differs from what is stored; an empty
    /// body clears it.
    func detailSetDescription(taskId: String, text: String) async {
        guard let task = items[taskId], text != (task.description ?? "") else { return }
        let value: String? = text.isEmpty ? nil : text
        await perform(nil) { try $0.setDescription(id: taskId, description: value) }
    }

    func detailUnarchive(_ task: TaskItem) async {
        let id = task.id
        await perform(TasksCopy.updated) { try $0.bulkUnarchive(ids: [id]) }
    }

    // MARK: Tags

    /// Adds a tag unless the task already has it in any case (desktop
    /// `TagAutocomplete.addTag`).
    func detailAddTag(_ task: TaskItem, _ raw: String) async {
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tag.isEmpty, !task.tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame })
        else { return }
        let id = task.id
        let tags = task.tags + [tag]
        await perform(nil) { try $0.setTags(id: id, tags: tags) }
    }

    func detailRemoveTag(_ task: TaskItem, _ tag: String) async {
        let id = task.id
        let tags = task.tags.filter { $0 != tag }
        await perform(nil) { try $0.setTags(id: id, tags: tags) }
    }

    /// Tags already used on this vault's tasks to offer while typing: with no
    /// query the five most used, otherwise up to eight containing it. A tag
    /// the task already has (in any case) is never offered.
    func detailTagSuggestions(query: String, excluding current: [String]) -> [String] {
        var counts: [String: (name: String, count: Int)] = [:]
        for task in ordered {
            for tag in task.tags {
                let key = tag.lowercased()
                counts[key, default: (tag, 0)].count += 1
            }
        }
        let taken = Set(current.map { $0.lowercased() })
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let ranked = counts
            .filter { !taken.contains($0.key) && (needle.isEmpty || $0.key.contains(needle)) }
            .values
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.name < $1.name }
            .map(\.name)
        return Array(ranked.prefix(needle.isEmpty ? 5 : 8))
    }

    // MARK: Related items

    /// The task's related notes and canvases, each present, missing or not on
    /// this device (the core decides which).
    func detailLinkedItems(taskId: String) async -> [LinkedItemRecord] {
        await read { try $0.linkedItems(taskId: taskId) } ?? []
    }

    /// Picker results, without the items the task already links.
    func detailSearchRelated(_ query: String, for task: TaskItem) async -> [RelatedItemRecord] {
        let found = await read { try $0.searchRelated(query: query, limit: 20) } ?? []
        return found.filter { item in
            item.kind == "canvas"
                ? !task.linkedCanvasIds.contains(item.id)
                : !task.linkedNoteIds.contains(item.id)
        }
    }

    /// Links a picked item: canvases into `linkedCanvasIds`, everything else
    /// (notes, files, journal entries) into `linkedNoteIds`, as desktop does.
    func detailAddRelated(_ item: RelatedItemRecord, to task: TaskItem) async {
        let id = task.id
        if item.kind == "canvas" {
            guard !task.linkedCanvasIds.contains(item.id) else { return }
            let ids = task.linkedCanvasIds + [item.id]
            await perform(nil) { try $0.setLinkedCanvasIds(id: id, ids: ids) }
        } else {
            guard !task.linkedNoteIds.contains(item.id) else { return }
            let ids = task.linkedNoteIds + [item.id]
            await perform(nil) { try $0.setLinkedNoteIds(id: id, ids: ids) }
        }
    }

    func detailRemoveRelated(_ linked: LinkedItemRecord, from task: TaskItem) async {
        let id = task.id
        if linked.field == "canvas" {
            let ids = task.linkedCanvasIds.filter { $0 != linked.id }
            await perform(nil) { try $0.setLinkedCanvasIds(id: id, ids: ids) }
        } else {
            let ids = task.linkedNoteIds.filter { $0 != linked.id }
            await perform(nil) { try $0.setLinkedNoteIds(id: id, ids: ids) }
        }
    }

    // MARK: Activity

    /// One page of the task's activity, newest first; `action` narrows it to
    /// one action (`nil` for every change).
    func detailActivity(
        taskId: String,
        action: String?,
        limit: UInt32,
        offset: UInt32
    ) async -> ActivityPageItem? {
        let actions = action.map { [$0] } ?? []
        return await read { try $0.activity(taskId: taskId, actions: actions, limit: limit, offset: offset) }
    }
}
