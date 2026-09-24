import Foundation
import MemryCore

// RD03 / RD04. What the composer (Paper artboards 03–04) creates. The typed
// text is the core's (`parseQuickAdd`: `@date`, `every …`, `!priority`,
// `+project`, `#tag`, `[[note]]`); a chip the user sets wins over the text for
// its property, so the chips always show what will be written. What the
// composer resolves here is only which of the two applies, and where the
// task lands when neither says (desktop's `resolveQuickAddProject`).
//
// The composer replaces the Add Task sheet (goal "Fixed decisions"): every
// field it had (description, status, parent, start date, repeat, reminder,
// tags) is a chip or behind the "…" chip, and Return ("next") keeps the
// composer open for the next task, as "Create another" did.

/// Why the composer opened, with the values it starts from.
struct TaskComposerRequest: Identifiable, Equatable {
    let id = UUID()
    /// The surface's project (a project hub, a project scope).
    var projectId: String?
    /// "Add task for today/tomorrow", a board due column.
    var dueDate: String?
    /// A board status column.
    var statusId: String?
    /// A board priority column.
    var priority: Int64?
    /// Opened to add a subtask.
    var parentId: String?
}

/// The chips the user set by hand. `nil` follows the typed text.
struct TaskComposerDraft: Equatable {
    enum Due: Equatable {
        case set(date: String, time: String?)
        case cleared
    }

    enum Rule: Equatable {
        case set(RepeatRule, repeatFrom: String?)
        case cleared
    }

    var notes = ""
    var due: Due?
    var priority: Int64?
    var projectId: String?
    var statusId: String?
    var parentId: String?
    var tags: [String] = []
    var rule: Rule?
    var startDate: String?
    var reminder: Date?

    /// Return ("next"): the next task keeps the project, parent, status and
    /// date, as desktop's "Create another" keeps project, parent and date;
    /// everything a new task would not share is cleared.
    mutating func resetForNext() {
        notes = ""
        priority = nil
        tags = []
        rule = nil
        startDate = nil
        reminder = nil
        if case let .set(date, _) = due { due = .set(date: date, time: nil) }
    }
}

/// What the composer would write now: every property resolved.
struct TaskComposerValues: Equatable {
    var title: String
    var dueDate: String?
    var dueTime: String?
    var priority: Int64
    var projectId: String?
    var statusId: String?
    var parentId: String?
    var tags: [String]
    var rule: RepeatRule?
    var repeatFrom: String?
    var startDate: String?
    var reminder: Date?

    /// - Parameters:
    ///   - parse: the core's reading of the text, when it matches the text.
    ///   - fallbackDue: the view's own day (today on Today), used when
    ///     neither a chip nor the text names one.
    ///   - resolveProject: the store's project chain, from a parsed or
    ///     preferred project id.
    static func resolve(
        text: String,
        parse: QuickAddParse?,
        draft: TaskComposerDraft,
        request: TaskComposerRequest,
        fallbackDue: String?,
        resolveProject: (_ parsed: String?, _ preferred: String?) -> String?
    ) -> TaskComposerValues {
        let title = (parse?.title ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
        var dueDate: String?
        var dueTime: String?
        switch draft.due {
        case let .set(date, time):
            dueDate = date
            dueTime = time
        case .cleared:
            break
        case nil:
            dueDate = parse?.dueDate ?? request.dueDate ?? fallbackDue
            dueTime = parse?.dueDate == nil ? nil : parse?.dueTime
        }
        var rule: RepeatRule?
        var repeatFrom: String?
        switch draft.rule {
        case let .set(value, from):
            rule = value
            repeatFrom = from
        case .cleared:
            break
        case nil:
            rule = parse?.repeat
        }
        let parsedPriority = parse.map(\.priority).flatMap { $0 > 0 ? $0 : nil }
        var tags = parse?.tags ?? []
        for tag in draft.tags where !tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) {
            tags.append(tag)
        }
        return TaskComposerValues(
            title: title,
            dueDate: dueDate,
            dueTime: dueTime,
            priority: draft.priority ?? parsedPriority ?? request.priority ?? 0,
            projectId: draft.projectId ?? resolveProject(parse?.projectId, request.projectId),
            statusId: draft.statusId ?? request.statusId,
            parentId: draft.parentId ?? request.parentId,
            tags: tags,
            rule: rule,
            repeatFrom: rule == nil ? nil : repeatFrom,
            startDate: draft.startDate,
            reminder: draft.reminder
        )
    }

    var canSubmit: Bool { !title.isEmpty && projectId != nil }
}

extension TasksStore {
    /// Creates the composed task (and its reminder); returns its id.
    @discardableResult
    func createComposedTask(
        _ values: TaskComposerValues,
        notes: String,
        noteTitles: [String],
        picks: QuickAddPicks
    ) async -> String? {
        guard values.canSubmit, let projectId = values.projectId else { return nil }
        var draft = TaskDraft()
        draft.title = values.title
        draft.description = notes
        draft.projectId = projectId
        // A status or parent from another project is dropped rather than
        // written across projects (the core refuses both).
        let project = project(projectId)
        draft.statusId = values.statusId.flatMap { id in project?.statuses.contains { $0.id == id } == true ? id : nil }
        draft.parentId = values.parentId.flatMap { id in items[id]?.projectId == projectId ? id : nil }
        draft.priority = values.priority
        draft.dueDate = values.dueDate
        draft.dueTime = values.dueDate == nil ? nil : values.dueTime
        draft.startDate = values.startDate
        draft.rule = values.rule
        draft.repeatFrom = values.repeatFrom
        draft.tags = values.tags
        draft.linkedNoteIds = await noteIds(for: noteTitles, picks: picks)
        guard let id = await createTask(draft) else { return nil }
        if let reminder = values.reminder {
            let created = undoable
            await addReminder(to: id, at: reminder, note: nil)
            // The create stays the change the toast can undo.
            undoable = created
            toast = created?.message ?? toast
        }
        return id
    }
}
