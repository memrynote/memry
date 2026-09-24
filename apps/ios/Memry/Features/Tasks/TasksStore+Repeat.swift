import Foundation
import MemryCore

// TP044 / TP045. The date and repeat questions the sheets ask, answered by
// the core's free functions, and the writes behind the Stop Repeating and
// Edit Repeating dialogs.
//
// **One live task per series.** Completing a repeating task creates the next
// occurrence (`Tasks.complete`), so "only this occurrence" means taking this
// task out of the series (`setRepeat(nil)`) and then applying the edit to it;
// "this and all future" applies the edit to the series' one live task. A rule
// edit scoped to "only this" is just the detach: re-applying the new rule to
// the detached task would be "this and future" again. Desktop ships the dialog
// (`edit-repeating-task-dialog.tsx`) but mounts it nowhere, so there is no
// desktop handler to match.

extension TasksStore {
    // MARK: Dates (TP044)

    /// `parseNaturalDate` against the user's clock.
    func parsedDate(_ input: String) -> ParsedDate? {
        parseTaskDate(input: input, now: localNow())
    }

    /// What the natural-language field shows for `input`.
    func dateReading(_ input: String) -> TaskDateReading {
        guard !input.trimmingCharacters(in: .whitespaces).isEmpty else { return .empty }
        if let parsed = parsedDate(input) { return .resolved(parsed) }
        return isTaskTimeInProgress(query: input, now: localNow()) ? .typing : .notUnderstood
    }

    /// The ghost text after `input`: the rest of the core's completion.
    func dateGhost(_ input: String) -> String? {
        guard !input.trimmingCharacters(in: .whitespaces).isEmpty,
              let candidate = predictTaskDate(query: input, now: localNow()),
              candidate.count > input.count,
              candidate.lowercased().hasPrefix(input.lowercased())
        else { return nil }
        return String(candidate.dropFirst(input.count))
    }

    /// Today, Tomorrow, This Weekend (not on a weekend, as desktop) and Next
    /// Week, each resolved by the core.
    func dateSuggestions() -> [TaskDateSuggestion] {
        let weekday = Calendar(identifier: .gregorian).component(.weekday, from: clock())
        let isWeekend = weekday == 1 || weekday == 7
        return TaskDateSuggestion.Kind.allCases.compactMap { kind in
            if kind == .weekend, isWeekend { return nil }
            guard let parsed = parsedDate(kind.phrase) else { return nil }
            return TaskDateSuggestion(kind: kind, date: parsed.date)
        }
    }

    // MARK: Repeat (TP045)

    /// The day presets and previews start from: the due date, else today.
    func repeatAnchor(_ anchorDate: String?) -> RepeatAnchor {
        anchorDate.flatMap(RepeatAnchor.init(key:)) ?? RepeatAnchor(date: clock())
    }

    func repeatPresets(anchorDate: String?) -> [RepeatPreset] {
        RepeatPreset.all(anchor: repeatAnchor(anchorDate))
    }

    /// The next `count` dates of `rule` from the anchor, the anchor first.
    func repeatPreviewDates(_ rule: RepeatRule, anchorDate: String?, count: UInt32 = 5) -> [String] {
        repeatPreview(rule: rule, start: String((anchorDate ?? today()).prefix(10)), count: count)
    }

    /// Whether the task already repeats, readable rule or not.
    func isRepeating(_ taskId: String?) -> Bool {
        guard let taskId, let task = items[taskId] else { return false }
        return task.isRepeating || task.repeat != nil
    }

    // MARK: Prompts

    private static func editKey(_ taskId: String) -> String { "repeat.edit.\(taskId)" }

    /// Routes an edit to a task: a repeating one asks the Edit Repeating
    /// question first, any other takes the edit now.
    func requestRepeatingEdit(taskId: String, _ edit: RepeatingEdit) async {
        guard isRepeating(taskId) else {
            await applyRepeatingEdit(taskId: taskId, edit, onlyThis: false)
            return
        }
        stashRepeatingEdit(taskId: taskId, edit)
        prompt = .editRepeating(taskId: taskId)
    }

    /// Keeps `edit` for the Edit Repeating dialog.
    func stashRepeatingEdit(taskId: String, _ edit: RepeatingEdit) {
        let stored = StoredRepeatingEdit(edit)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        scratch[Self.editKey(taskId)] = String(bytes: data, encoding: .utf8)
    }

    func pendingRepeatingEdit(taskId: String) -> RepeatingEdit? {
        guard let json = scratch[Self.editKey(taskId)],
              let stored = try? JSONDecoder().decode(StoredRepeatingEdit.self, from: Data(json.utf8))
        else { return nil }
        return stored.edit
    }

    /// Closes a repeating dialog without writing.
    func dismissRepeatingPrompt() {
        switch prompt {
        case let .editRepeating(id):
            scratch[Self.editKey(id)] = nil
            prompt = nil
        case .stopRepeating:
            prompt = nil
        default:
            break
        }
    }

    /// Stop Repeating: keep the task as a one-time task, or delete it (the
    /// series has no other live occurrence).
    func stopRepeating(taskId: String, deleteSeries: Bool) async {
        if deleteSeries {
            guard let task = items[taskId] else { return }
            await requestDelete(task)
        } else {
            await perform(TasksCopy.updated) { try $0.setRepeat(id: taskId, rule: nil, repeatFrom: nil) }
        }
    }

    /// Edit Repeating: "only this" detaches the task first; one undo reverts
    /// both writes.
    func applyRepeatingEdit(taskId: String, _ edit: RepeatingEdit, onlyThis: Bool) async {
        scratch[Self.editKey(taskId)] = nil
        let detach = onlyThis && isRepeating(taskId)
        await perform(TasksCopy.updated) { core in
            var detached: TaskChange?
            if detach {
                detached = try core.setRepeat(id: taskId, rule: nil, repeatFrom: nil)
            }
            var edited: TaskChange?
            switch edit {
            case let .rule(rule, from):
                if !detach { edited = try core.setRepeat(id: taskId, rule: rule, repeatFrom: from) }
            case let .due(date, time):
                edited = try core.setDue(id: taskId, date: date, time: time)
            case let .start(date):
                edited = try core.setStartDate(id: taskId, date: date)
            }
            return TasksStore.merge(detached, edited)
        }
    }
}
