import Foundation
import MemryCore
import Testing

@testable import Memry

// TP044 / TP045: the date sheet's readings and suggestions, the repeat
// presets, custom draft, preview, the sheet's outcome and the Stop / Edit
// Repeating writes, over the real core (clock: Wednesday 2026-01-14 12:00).

@MainActor
@Suite("Task dates and repeat", .serialized)
struct TasksDatesTests {
    private static func weekly(_ days: [Int64], interval: Int64 = 1) -> RepeatRule {
        RepeatRule(
            frequency: "weekly", interval: interval, daysOfWeek: days, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never", endDate: nil, endCount: nil,
            completedCount: 0, createdAt: nil
        )
    }

    // MARK: Dates

    @Test func suggestions_are_the_cores_dates() throws {
        let vault = try TasksTestVault()
        let suggestions = vault.store.dateSuggestions()
        #expect(suggestions.map(\.kind) == [.today, .tomorrow, .weekend, .nextWeek])
        #expect(suggestions.map(\.date) == ["2026-01-14", "2026-01-15", "2026-01-17", "2026-01-19"])
    }

    @Test func the_natural_field_reads_live() throws {
        let vault = try TasksTestVault()
        let store = vault.store
        #expect(store.dateReading("  ") == .empty)
        guard case let .resolved(parsed) = store.dateReading("next friday") else {
            Issue.record("next friday did not resolve")
            return
        }
        #expect(parsed.date == "2026-01-16")
        #expect(store.dateReading("dec 25 3pm") != .notUnderstood)
        #expect(store.dateReading("banana") == .notUnderstood)
        #expect(store.dateReading("today at") == .typing)
    }

    // RD11: the When sheet's field reads repeats with their time too.
    @Test func the_when_field_reads_a_repeat_with_its_time() async throws {
        let vault = try TasksTestVault()
        let reading = try #require(await vault.store.whenReading("every thu 3pm"))
        #expect(reading.rule?.frequency == "weekly")
        #expect(reading.time == "15:00")
        #expect(reading.date != nil)
        #expect(await vault.store.whenReading("next friday")?.date == "2026-01-16")
        #expect(await vault.store.whenReading("   ") == nil)
    }

    @Test func the_ghost_is_the_rest_of_the_cores_completion() throws {
        let vault = try TasksTestVault()
        #expect(vault.store.dateGhost("tom") == "orrow")
        #expect(vault.store.dateGhost("") == nil)
        #expect(vault.store.dateGhost("tomorrow") == nil)
    }

    @Test func a_time_round_trips_through_the_picker_date() throws {
        let date = try #require(TaskTimeText.date("14:30"))
        #expect(TaskTimeText.string(date) == "14:30")
    }

    // MARK: Presets and labels

    @Test func presets_follow_desktop_for_the_anchor_day() throws {
        let vault = try TasksTestVault()
        let presets = vault.store.repeatPresets(anchorDate: "2026-01-14")
        #expect(presets.map(\.kind) == RepeatPreset.Kind.allCases)
        #expect(presets.map(TasksCopy.repeatPresetLabel) == [
            "Every day",
            "Every weekday (Mon-Fri)",
            "Every week on Wednesday",
            "Every 2 weeks on Wednesday",
            "Every month on the 14th",
            "Every month on the second Wednesday",
            "Every year on January 14"
        ])
        let byWeek = try #require(presets.first { $0.kind == .monthlyWeek })
        #expect(byWeek.rule.weekOfMonth == 2)
        #expect(byWeek.rule.dayOfWeekForMonth == 3)
        #expect(byWeek.rule.endType == "never")
    }

    @Test func the_last_weekday_of_a_month_is_week_five() throws {
        let vault = try TasksTestVault()
        let presets = vault.store.repeatPresets(anchorDate: "2026-01-28")
        let byWeek = try #require(presets.first { $0.kind == .monthlyWeek })
        #expect(byWeek.rule.weekOfMonth == 5)
        #expect(TasksCopy.repeatPresetLabel(byWeek) == "Every month on the last Wednesday")
    }

    @Test func presets_anchor_on_today_without_a_due_date() throws {
        let vault = try TasksTestVault()
        let weekly = try #require(vault.store.repeatPresets(anchorDate: nil).first { $0.kind == .weekly })
        #expect(weekly.rule.daysOfWeek == [3])
    }

    @Test func summaries_read_as_desktops() {
        #expect(TasksCopy.repeatSummary(Self.weekly([1, 2, 3, 4, 5])) == "Every weekday")
        #expect(TasksCopy.repeatSummary(Self.weekly([0, 6], interval: 2)) == "Every 2 weeks on weekends")
        #expect(TasksCopy.repeatSummary(Self.weekly([5, 1, 3])) == "Every week on Mon, Wed, Fri")
        #expect(TasksCopy.repeatSummary(Self.weekly([])) == "Every week")
        var yearly = Self.weekly([])
        yearly.frequency = "yearly"
        yearly.interval = 3
        #expect(TasksCopy.repeatSummary(yearly) == "Every 3 years")
        yearly.frequency = "hourly"
        #expect(TasksCopy.repeatSummary(yearly) == TasksCopy.repeats)
        #expect(TasksCopy.ordinalSuffix(11) == "th")
        #expect(TasksCopy.ordinalSuffix(22) == "nd")
    }

    // MARK: Custom draft and preview

    @Test func the_custom_draft_builds_only_its_frequencys_fields() throws {
        let anchor = try #require(RepeatAnchor(key: "2026-01-14"))
        var draft = RepeatDraft(rule: nil, anchor: anchor)
        #expect(draft.rule.frequency == "weekly")
        #expect(draft.rule.daysOfWeek == [3])
        draft.toggle(day: 3)
        #expect(draft.daysOfWeek == [3])
        draft.toggle(day: 1)
        #expect(draft.rule.daysOfWeek == [1, 3])
        draft.frequency = "monthly"
        draft.monthlyType = "weekPattern"
        draft.endType = "count"
        let rule = draft.rule
        #expect(rule.daysOfWeek == nil)
        #expect(rule.dayOfMonth == nil)
        #expect(rule.weekOfMonth == 2)
        #expect(rule.dayOfWeekForMonth == 3)
        #expect(rule.endCount == 10)
        #expect(rule.endDate == nil)
    }

    @Test func the_draft_keeps_a_stored_rules_progress() throws {
        let anchor = try #require(RepeatAnchor(key: "2026-01-14"))
        var stored = Self.weekly([2])
        stored.completedCount = 4
        stored.createdAt = "2026-01-01T00:00:00.000Z"
        let rule = RepeatDraft(rule: stored, anchor: anchor).rule
        #expect(rule.completedCount == 4)
        #expect(rule.createdAt == "2026-01-01T00:00:00.000Z")
        #expect(rule.daysOfWeek == [2])
    }

    @Test func the_preview_is_the_cores_next_dates() throws {
        let vault = try TasksTestVault()
        var daily = Self.weekly([])
        daily.frequency = "daily"
        daily.daysOfWeek = nil
        let dates = vault.store.repeatPreviewDates(daily, anchorDate: "2026-01-14")
        #expect(dates == ["2026-01-14", "2026-01-15", "2026-01-16", "2026-01-17", "2026-01-18"])
        daily.endType = "count"
        daily.endCount = 3
        #expect(vault.store.repeatPreviewDates(daily, anchorDate: nil).count == 3)
        #expect(TasksCopy.repeatPreviewHeader(daily) == "3 occurrences:")
    }

    // MARK: Sheet outcome

    @Test func done_commits_for_a_new_task_and_asks_for_a_repeating_one() {
        let rule = Self.weekly([3])
        let other = Self.weekly([4])
        func resolve(_ id: String?, _ was: Bool, _ original: RepeatRule?, _ draft: RepeatRule?) -> RepeatSheetOutcome {
            RepeatSheetOutcome.resolve(
                taskId: id, wasRepeating: was, original: RepeatChoice(rule: original),
                draft: RepeatChoice(rule: draft), touched: true
            )
        }
        #expect(resolve(nil, false, nil, rule) == .commit(rule, repeatFrom: nil))
        #expect(resolve("t", false, nil, rule) == .commit(rule, repeatFrom: nil))
        #expect(resolve("t", true, rule, rule) == .unchanged)
        #expect(resolve("t", true, rule, nil) == .stopRepeating(taskId: "t"))
        #expect(resolve("t", true, nil, nil) == .stopRepeating(taskId: "t"))
        #expect(resolve("t", true, rule, other) == .editRepeating(taskId: "t", edit: .rule(other, repeatFrom: nil)))
        let untouched = RepeatSheetOutcome.resolve(
            taskId: "t", wasRepeating: true, original: RepeatChoice(rule: rule),
            draft: RepeatChoice(rule: nil), touched: false
        )
        #expect(untouched == .unchanged)
        let anchorOnly = RepeatSheetOutcome.resolve(
            taskId: "t", wasRepeating: true, original: RepeatChoice(rule: rule),
            draft: RepeatChoice(rule: rule, repeatFrom: "completion"), touched: true
        )
        #expect(anchorOnly == .editRepeating(taskId: "t", edit: .rule(rule, repeatFrom: "completion")))
    }

    @Test func a_pending_edit_survives_the_scratch() throws {
        let vault = try TasksTestVault()
        let edits: [RepeatingEdit] = [
            .rule(Self.weekly([1, 5]), repeatFrom: "completion"),
            .due(date: "2026-02-01", time: "09:30"),
            .start(date: nil)
        ]
        for edit in edits {
            vault.store.stashRepeatingEdit(taskId: "t", edit)
            #expect(vault.store.pendingRepeatingEdit(taskId: "t") == edit)
        }
    }

    // MARK: Writes

    private func repeatingTask(_ vault: TasksTestVault) async throws -> String {
        let project = try vault.project()
        let id = try vault.task("[agent] weekly", project: project, due: "2026-01-14")
        _ = try vault.tasks.setRepeat(id: id, rule: Self.weekly([3]), repeatFrom: nil)
        await vault.store.load()
        return id
    }

    @Test func stop_repeating_keeps_a_one_time_task() async throws {
        let vault = try TasksTestVault()
        let id = try await repeatingTask(vault)
        #expect(vault.store.isRepeating(id))
        await vault.store.stopRepeating(taskId: id, deleteSeries: false)
        #expect(vault.store.items[id]?.isRepeating == false)
        #expect(vault.store.items[id]?.dueDate == "2026-01-14")
    }

    @Test func stop_repeating_can_delete_the_series() async throws {
        let vault = try TasksTestVault()
        let id = try await repeatingTask(vault)
        await vault.store.stopRepeating(taskId: id, deleteSeries: true)
        #expect(vault.store.items[id] == nil)
    }

    @Test func an_edit_to_a_repeating_task_asks_first() async throws {
        let vault = try TasksTestVault()
        let id = try await repeatingTask(vault)
        await vault.store.requestRepeatingEdit(taskId: id, .due(date: "2026-01-20", time: nil))
        #expect(vault.store.prompt == .editRepeating(taskId: id))
        #expect(vault.store.items[id]?.dueDate == "2026-01-14")
        vault.store.dismissRepeatingPrompt()
        #expect(vault.store.prompt == nil)
        #expect(vault.store.pendingRepeatingEdit(taskId: id) == nil)
    }

    @Test func only_this_occurrence_detaches_then_edits_in_one_undo() async throws {
        let vault = try TasksTestVault()
        let id = try await repeatingTask(vault)
        await vault.store.applyRepeatingEdit(taskId: id, .due(date: "2026-01-20", time: "10:00"), onlyThis: true)
        #expect(vault.store.items[id]?.isRepeating == false)
        #expect(vault.store.items[id]?.dueDate == "2026-01-20")
        #expect(vault.store.items[id]?.dueTime == "10:00")

        await vault.store.undo()
        #expect(vault.store.items[id]?.isRepeating == true)
        #expect(vault.store.items[id]?.dueDate == "2026-01-14")
    }

    @Test func this_and_future_changes_the_series() async throws {
        let vault = try TasksTestVault()
        let id = try await repeatingTask(vault)
        let next = Self.weekly([1, 4])
        await vault.store.applyRepeatingEdit(taskId: id, .rule(next, repeatFrom: "completion"), onlyThis: false)
        #expect(vault.store.items[id]?.repeat?.daysOfWeek == [1, 4])
        #expect(vault.store.items[id]?.repeatFrom == "completion")

        await vault.store.applyRepeatingEdit(taskId: id, .rule(next, repeatFrom: nil), onlyThis: true)
        #expect(vault.store.items[id]?.isRepeating == false)
    }

    @Test func an_edit_to_a_one_time_task_applies_at_once() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] once", project: project)
        await vault.store.load()
        await vault.store.requestRepeatingEdit(taskId: id, .start(date: "2026-01-16"))
        #expect(vault.store.prompt == nil)
        #expect(vault.store.items[id]?.startDate == "2026-01-16")
    }
}
