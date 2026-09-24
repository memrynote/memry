import Foundation
import MemryCore
import Testing

@testable import Memry

// TP043: the task detail's store operations over the real core, and how its
// activity entries, repeat and meta read.

@MainActor
@Suite("Task detail", .serialized)
struct TasksDetailTests {
    private func loaded(_ title: String = "[agent] detail") async throws -> (TasksTestVault, String) {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task(title, project: project)
        await vault.store.load()
        return (vault, id)
    }

    private func item(_ vault: TasksTestVault, _ id: String) throws -> TaskItem {
        try #require(vault.store.items[id])
    }

    @Test func an_unknown_task_id_is_absent_not_a_crash() async throws {
        let (vault, _) = try await loaded()
        #expect(vault.store.items["no-such-task"] == nil)
        #expect(try vault.tasks.get(id: "no-such-task") == nil)
        #expect(await vault.store.detailLinkedItems(taskId: "no-such-task").isEmpty)
    }

    @Test func rename_trims_and_drops_a_blank_or_unchanged_title() async throws {
        let (vault, id) = try await loaded()
        #expect(await vault.store.detailRename(try item(vault, id), to: "   ") == false)
        #expect(await vault.store.detailRename(try item(vault, id), to: "[agent] detail") == false)
        #expect(await vault.store.detailRename(try item(vault, id), to: "  [agent] renamed  "))
        #expect(try item(vault, id).title == "[agent] renamed")
        #expect(vault.store.undoable == nil)
    }

    @Test func status_priority_due_and_project_edits_are_undoable() async throws {
        let (vault, id) = try await loaded()
        let task = try item(vault, id)
        let project = try #require(vault.store.project(task.projectId))
        let doing = try #require(project.statuses.first { $0.statusType == "in_progress" })

        await vault.store.detailSetStatus(task, statusId: doing.id)
        #expect(try item(vault, id).statusId == doing.id)
        #expect(vault.store.undoable?.message == TasksCopy.Detail.statusChanged)

        await vault.store.detailSetPriority(try item(vault, id), 3)
        #expect(try item(vault, id).priority == 3)
        #expect(vault.store.undoable?.message == "Priority → High")

        await vault.store.detailSetDue(try item(vault, id), date: "2026-01-20", time: "09:30")
        #expect(try item(vault, id).dueDate == "2026-01-20")
        #expect(try item(vault, id).dueTime == "09:30")
        #expect(vault.store.undoable?.message == TasksCopy.Detail.dueDateChanged)
        await vault.store.undo()
        #expect(try item(vault, id).dueDate == nil)

        let other = try vault.project("Agent Test Other")
        await vault.store.refresh()
        await vault.store.detailMove(try item(vault, id), toProject: other)
        #expect(try item(vault, id).projectId == other)
        #expect(vault.store.undoable?.message == TasksCopy.Detail.movedToProject)
    }

    @Test func start_date_sets_and_clears_without_undo() async throws {
        let (vault, id) = try await loaded()
        await vault.store.detailSetStartDate(try item(vault, id), date: "2026-01-16")
        #expect(try item(vault, id).startDate == "2026-01-16")
        await vault.store.detailSetStartDate(try item(vault, id), date: nil)
        #expect(try item(vault, id).startDate == nil)
        #expect(vault.store.undoable == nil)
    }

    @Test func tags_add_once_in_any_case_and_remove() async throws {
        let (vault, id) = try await loaded()
        await vault.store.detailAddTag(try item(vault, id), "  Work ")
        await vault.store.detailAddTag(try item(vault, id), "work")
        await vault.store.detailAddTag(try item(vault, id), "home")
        #expect(try item(vault, id).tags == ["Work", "home"])
        await vault.store.detailRemoveTag(try item(vault, id), "Work")
        #expect(try item(vault, id).tags == ["home"])
    }

    @Test func tag_suggestions_come_from_other_tasks_and_skip_the_tasks_own() async throws {
        let (vault, id) = try await loaded()
        let project = try item(vault, id).projectId
        let other = try vault.task("[agent] other", project: project)
        let third = try vault.task("[agent] third", project: project)
        try vault.tasks.setTags(id: other, tags: ["errands", "Home"])
        try vault.tasks.setTags(id: third, tags: ["home"])
        await vault.store.refresh()
        await vault.store.detailAddTag(try item(vault, id), "errands")

        let popular = vault.store.detailTagSuggestions(query: "", excluding: try item(vault, id).tags)
        #expect(popular.count == 1)
        #expect(popular.first?.lowercased() == "home")
        #expect(vault.store.detailTagSuggestions(query: "HO", excluding: []).count == 1)
        #expect(vault.store.detailTagSuggestions(query: "zzz", excluding: []).isEmpty)
    }

    @Test func description_saves_once_and_logs_only_its_length() async throws {
        let (vault, id) = try await loaded()
        await vault.store.detailSetDescription(taskId: id, text: "**Bold** plan")
        #expect(try item(vault, id).description == "**Bold** plan")
        await vault.store.detailSetDescription(taskId: id, text: "**Bold** plan")

        let page = try #require(await vault.store.detailActivity(taskId: id, action: nil, limit: 50, offset: 0))
        let edits = page.entries.filter { $0.field == "description" }
        #expect(edits.count == 1)
        let line = TaskActivityFormat.line(try #require(edits.first), now: TasksTestVault.referenceNow)
        #expect(line.summary == "+13 chars")

        await vault.store.detailSetDescription(taskId: id, text: "")
        #expect(try item(vault, id).description == nil)
    }

    @Test func activity_previews_three_and_filters_by_action() async throws {
        let (vault, id) = try await loaded()
        for priority in [Int64(1), 2, 3, 4] {
            await vault.store.detailSetPriority(try item(vault, id), priority)
        }
        let preview = try #require(
            await vault.store.detailActivity(taskId: id, action: nil, limit: TaskActivityPaging.preview, offset: 0)
        )
        #expect(preview.entries.count == 3)
        #expect(Int(preview.total) > preview.entries.count)
        #expect(preview.hasMore)

        let created = try #require(
            await vault.store.detailActivity(taskId: id, action: "created", limit: 50, offset: 0)
        )
        #expect(created.entries.allSatisfy { $0.action == "created" })
    }

    @Test func unarchive_brings_a_task_back() async throws {
        let (vault, id) = try await loaded()
        _ = try vault.tasks.bulkArchive(ids: [id])
        await vault.store.refresh()
        #expect(try item(vault, id).archivedAt != nil)
        #expect(TaskDetailMeta.day(try item(vault, id).archivedAt) != nil)

        await vault.store.detailUnarchive(try item(vault, id))
        #expect(try item(vault, id).archivedAt == nil)
        #expect(vault.store.undoable?.message == TasksCopy.updated)
    }

    @Test func a_related_id_this_vault_lacks_reads_missing_and_can_be_removed() async throws {
        let (vault, id) = try await loaded()
        _ = try vault.tasks.setLinkedNoteIds(id: id, ids: ["gone-note"])
        _ = try vault.tasks.setLinkedCanvasIds(id: id, ids: ["some-canvas"])
        await vault.store.refresh()

        let linked = await vault.store.detailLinkedItems(taskId: id)
        let note = try #require(linked.first { $0.field == "note" })
        #expect(note.state == "missing")
        #expect(linked.contains { $0.field == "canvas" && $0.state != "present" })

        await vault.store.detailRemoveRelated(note, from: try item(vault, id))
        #expect(try item(vault, id).linkedNoteIds.isEmpty)
        #expect(try item(vault, id).linkedCanvasIds == ["some-canvas"])
    }

    @Test func activity_values_read_as_the_properties_show_them() {
        #expect(TaskActivityFormat.value("3", field: "priority") == "High")
        #expect(TaskActivityFormat.value("null", field: "dueDate") == TasksCopy.Detail.activityEmptyValue)
        #expect(TaskActivityFormat.value("[\"a\",\"b\"]", field: "tags") == "a, b")
        #expect(TaskActivityFormat.value("[]", field: "tags") == TasksCopy.Detail.activityEmptyValue)
        #expect(TaskActivityFormat.value("{\"frequency\":\"daily\"}", field: "repeatConfig") == "changed")
        #expect(TaskActivityFormat.value("\"Inbox\"", field: "projectId") == "Inbox")
        #expect(TaskActivityFormat.descriptionSummary("{\"delta\":-4}") == "-4 chars")
        #expect(TaskActivityFormat.descriptionSummary("{\"delta\":0}") == "reworded")
        #expect(TasksCopy.Detail.activityField("somethingNew") == "somethingNew")
        #expect(TasksCopy.Detail.activityAction("uncompleted") == "Reopened")
    }

    @Test func activity_groups_by_day_newest_first() {
        let now = TasksTestVault.referenceNow
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        let day: Int64 = 86_400_000
        func entry(_ id: String, _ stamp: Int64?) -> ActivityItem {
            ActivityItem(
                id: id, action: "updated", field: "title", oldValue: nil, newValue: nil,
                isThisDevice: true, createdAtMs: stamp
            )
        }
        let days = TaskActivityFormat.days(
            [entry("a", nowMs), entry("b", nowMs - 60_000), entry("c", nowMs - day), entry("d", nil)],
            now: now
        )
        #expect(days.map(\.label).prefix(2) == [TasksCopy.Detail.activityToday, TasksCopy.Detail.activityYesterday])
        #expect(days.first?.entries.count == 2)
        #expect(days.last?.label == TasksCopy.Detail.activityUnknownDate)
    }

    @Test func repeat_text_reads_the_rule() {
        #expect(TasksCopy.Detail.repeatSummary(frequency: "weekly", interval: 1) == "Weekly")
        #expect(TasksCopy.Detail.repeatSummary(frequency: "daily", interval: 3) == "Every 3 days")
        let rule = RepeatRule(
            frequency: "daily", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "count", endDate: nil, endCount: 5,
            completedCount: 2, createdAt: nil
        )
        #expect(TaskRepeatText.info(rule) == "Ends: After 5x | Done: 2x")
        #expect(TaskRepeatText.info(nil) == nil)
    }

    // RD08: the footer is one line: created, edited and (when so) archived.
    @Test func the_footer_line_names_created_edited_and_archived() async throws {
        let (vault, id) = try await loaded()
        let fresh = TaskDetailMeta.line(try item(vault, id), now: vault.store.clock())
        #expect(fresh.hasPrefix("Created "))
        #expect(fresh.contains(TasksCopy.subtitleSeparator + "Edited "))
        #expect(!fresh.contains("Archived"))

        _ = try vault.tasks.bulkArchive(ids: [id])
        await vault.store.refresh()
        #expect(TaskDetailMeta.line(try item(vault, id), now: vault.store.clock()).contains("Archived "))
    }

    // RD11: on a series, a date change and a rule change made together raise
    // one question (Edit Repeating, carrying the date), not two.
    @Test func a_when_sheet_date_change_on_a_series_asks_once() async throws {
        let (vault, id) = try await loaded()
        let rule = RepeatRule(
            frequency: "weekly", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never", endDate: nil, endCount: nil,
            completedCount: 0, createdAt: nil
        )
        await vault.store.detailSetDue(try item(vault, id), date: "2026-09-25", time: nil)
        await vault.store.detailSetRepeat(try item(vault, id), rule: rule, repeatFrom: nil)
        let task = try item(vault, id)
        #expect(vault.store.isRepeating(id))

        let original = TaskWhenDraft(task: task)
        var draft = original
        draft.date = "2026-09-28"
        let daily = RepeatRule(
            frequency: "daily", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never", endDate: nil, endCount: nil,
            completedCount: 0, createdAt: nil
        )
        draft.rule = daily
        let prompt = TaskWhenCommit.write(
            store: vault.store, task: task, original: original, draft: draft, ruleTouched: true
        )
        #expect(prompt == .editRepeating(taskId: id))
        let pending = try #require(vault.store.pendingRepeatingEdit(taskId: id))
        #expect(pending == .due(date: "2026-09-28", time: nil))
        #expect(vault.store.followingRepeatingEdits(taskId: id).count == 1)

        // "This and all future": both the date and the rule land, one undo.
        await vault.store.applyRepeatingEdit(taskId: id, pending, onlyThis: false)
        #expect(try item(vault, id).dueDate == "2026-09-28")
        #expect(try item(vault, id).repeat?.frequency == "daily")
        #expect(vault.store.followingRepeatingEdits(taskId: id).isEmpty)
        #expect(vault.store.undoable != nil)
    }

    // RD11: ending a series with a date change asks Stop Repeating only.
    @Test func a_when_sheet_that_ends_a_series_asks_stop() async throws {
        let (vault, id) = try await loaded()
        let rule = RepeatRule(
            frequency: "weekly", interval: 1, daysOfWeek: nil, monthlyType: nil, dayOfMonth: nil,
            weekOfMonth: nil, dayOfWeekForMonth: nil, endType: "never", endDate: nil, endCount: nil,
            completedCount: 0, createdAt: nil
        )
        await vault.store.detailSetDue(try item(vault, id), date: "2026-09-25", time: nil)
        await vault.store.detailSetRepeat(try item(vault, id), rule: rule, repeatFrom: nil)
        let task = try item(vault, id)
        let original = TaskWhenDraft(task: task)
        var draft = original
        draft.rule = nil
        let prompt = TaskWhenCommit.write(
            store: vault.store, task: task, original: original, draft: draft, ruleTouched: true
        )
        #expect(prompt == .stopRepeating(taskId: id))
        #expect(vault.store.pendingRepeatingEdit(taskId: id) == nil)
    }

    // RD11: a plain task's When sheet writes the date directly, no question.
    @Test func a_when_sheet_date_change_on_a_plain_task_writes() async throws {
        let (vault, id) = try await loaded()
        let task = try item(vault, id)
        let original = TaskWhenDraft(task: task)
        var draft = original
        draft.date = "2026-09-28"
        draft.time = "09:30"
        let prompt = TaskWhenCommit.write(
            store: vault.store, task: task, original: original, draft: draft, ruleTouched: false
        )
        #expect(prompt == nil)
        for _ in 0..<50 where (try? item(vault, id).dueDate) != "2026-09-28" {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(try item(vault, id).dueDate == "2026-09-28")
        #expect(try item(vault, id).dueTime == "09:30")
    }

    @Test func markdown_preview_renders_inline_formatting() {
        let rendered = TaskDescriptionMarkdown.render("**Bold** and [link](https://memry.app)")
        #expect(String(rendered.characters) == "Bold and link")
        #expect(rendered.runs.contains { $0.link != nil })
    }
}
