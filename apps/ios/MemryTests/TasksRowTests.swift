import Foundation
import MemryCore
import Testing

@testable import Memry

// TP041: the task row's reads and writes (TasksStore+Row) over a real scratch
// vault and the real core, on the reference day Wednesday 2026-01-14.

@MainActor
@Suite("Task row", .serialized)
struct TasksRowTests {
    @Test func reschedule_targets_come_from_the_core_parser() throws {
        let vault = try TasksTestVault()
        #expect(vault.store.rowRescheduleDate(.today) == "2026-01-14")
        #expect(vault.store.rowRescheduleDate(.tomorrow) == "2026-01-15")
        // Desktop's move menu: today + 7 days, not next Monday.
        #expect(vault.store.rowRescheduleDate(.nextWeek) == "2026-01-21")
        #expect(vault.store.rowRescheduleDate(.removeDate) == nil)
    }

    @Test func reschedule_keeps_the_time_and_is_undoable() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] reschedule", project: project, due: "2026-01-10")
        _ = try vault.tasks.setDue(id: id, date: "2026-01-10", time: "09:30")
        await vault.store.load()
        let task = try #require(vault.store.items[id])

        await vault.store.rowReschedule(task, to: .tomorrow)
        #expect(vault.store.items[id]?.dueDate == "2026-01-15")
        #expect(vault.store.items[id]?.dueTime == "09:30")
        #expect(vault.store.undoable?.message == TasksCopy.rowRescheduledTo(TasksCopy.rowTomorrow))

        await vault.store.undo()
        #expect(vault.store.items[id]?.dueDate == "2026-01-10")
    }

    @Test func remove_date_clears_the_due_date() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] undated", project: project, due: "2026-01-20")
        await vault.store.load()
        let task = try #require(vault.store.items[id])

        await vault.store.rowReschedule(task, to: .removeDate)
        #expect(vault.store.items[id]?.dueDate == nil)
        #expect(vault.store.undoable?.message == TasksCopy.rowDueDateRemoved)
    }

    @Test func move_offers_live_projects_and_moves_the_task() async throws {
        let vault = try TasksTestVault()
        let home = try vault.project("Agent Test Home")
        let other = try vault.project("Agent Test Other")
        let archived = try vault.project("Agent Test Archived")
        try vault.tasks.setProjectArchived(id: archived, archived: true)
        let id = try vault.task("[agent] move me", project: home)
        await vault.store.load()

        let targets = vault.store.rowMoveTargets().map(\.id)
        #expect(targets.contains(home))
        #expect(targets.contains(other))
        #expect(!targets.contains(archived))

        let task = try #require(vault.store.items[id])
        let destination = try #require(vault.store.project(other))
        await vault.store.rowMove(task, to: destination)
        #expect(vault.store.items[id]?.projectId == other)
        #expect(vault.store.undoable?.message == TasksCopy.rowMovedTo("Agent Test Other"))
    }

    @Test func change_status_uses_the_projects_statuses() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] status", project: project)
        await vault.store.load()
        let task = try #require(vault.store.items[id])

        let statuses = vault.store.rowStatuses(task)
        #expect(statuses.count == 3)
        let inProgress = try #require(statuses.first { $0.statusType == "in_progress" })
        await vault.store.rowSetStatus(task, to: inProgress)
        let updated = try #require(vault.store.items[id])
        #expect(updated.statusId == inProgress.id)
        #expect(vault.store.rowStatus(updated)?.id == inProgress.id)
    }

    @Test func duplicate_copies_the_task_with_or_without_subtasks() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        _ = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()
        let task = try #require(vault.store.items[parent])
        let before = vault.store.ordered.count

        await vault.store.rowDuplicate(task, withSubtasks: false)
        #expect(vault.store.ordered.count == before + 1)

        await vault.store.rowDuplicate(task, withSubtasks: true)
        #expect(vault.store.ordered.count == before + 3)
    }

    @Test func archive_and_unarchive_toggle_archived_at() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] archive", project: project)
        await vault.store.load()

        await vault.store.rowToggleArchive(try #require(vault.store.items[id]))
        let archived = try #require(vault.store.items[id])
        #expect(archived.archivedAt != nil)
        #expect(vault.store.undoable?.message == TasksCopy.archived)

        await vault.store.rowToggleArchive(archived)
        #expect(vault.store.items[id]?.archivedAt == nil)
    }

    @Test func subtask_progress_and_the_parent_rule() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let first = try vault.task("[agent] one", project: project, parent: parent)
        _ = try vault.task("[agent] two", project: project, parent: parent)
        _ = try vault.tasks.complete(id: first, localNow: vault.store.localNow())
        await vault.store.load()

        let task = try #require(vault.store.items[parent])
        let counts = vault.store.rowSubtaskCounts(task)
        #expect(counts.done == 1)
        #expect(counts.total == 2)
        #expect(!vault.store.rowCanBecomeSubtask(task))
        let child = try #require(vault.store.items[first])
        #expect(vault.store.rowCanBecomeSubtask(child))
    }

    @Test func linked_notes_count_the_source_note_when_nothing_is_linked() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] linked", project: project)
        await vault.store.load()
        #expect(vault.store.rowLinkedNoteCount(try #require(vault.store.items[id])) == 0)

        _ = try vault.tasks.setLinkedNoteIds(id: id, ids: ["note-a", "note-b"])
        await vault.store.load()
        #expect(vault.store.rowLinkedNoteCount(try #require(vault.store.items[id])) == 2)
    }

    @Test func the_voiceover_sentence_reads_the_whole_row() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Label")
        let id = try vault.task("[agent] label", project: project, due: "2026-01-15", priority: 3)
        _ = try vault.tasks.setTags(id: id, tags: ["work"])
        await vault.store.load()

        let label = vault.store.rowAccessibilityLabel(try #require(vault.store.items[id]))
        #expect(label.hasPrefix("[agent] label"))
        #expect(label.contains(TasksCopy.rowPriority(3)))
        #expect(label.contains("Due Tomorrow"))
        #expect(label.contains(TasksCopy.rowProject("Agent Test Label")))
        #expect(label.contains(TasksCopy.rowTags(["work"])))
        #expect(!label.contains(TasksCopy.rowCompletedSuffix))
    }
}
