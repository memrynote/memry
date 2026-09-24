import Foundation
import MemryCore
import Testing

@testable import Memry

// TP047 / TP051: the selection helpers, every bulk write over the real core
// with its toast and one Undo, and the toast's Undo rules.

@MainActor
@Suite("Tasks bulk and undo", .serialized)
struct TasksBulkTests {
    // MARK: Selection

    @Test func range_select_covers_both_ends_in_either_direction() {
        let visible = ["a", "b", "c", "d", "e"]
        var down: Set<String> = ["b"]
        down.selectRange(from: "b", to: "d", in: visible)
        #expect(down == ["b", "c", "d"])

        var upward: Set<String> = ["x"]
        upward.selectRange(from: "e", to: "c", in: visible)
        #expect(upward == ["x", "c", "d", "e"])
    }

    @Test func range_select_without_a_visible_anchor_adds_only_the_target() {
        let visible = ["a", "b", "c"]
        var none: Set<String> = []
        none.selectRange(from: nil, to: "b", in: visible)
        #expect(none == ["b"])

        var gone: Set<String> = []
        gone.selectRange(from: "zz", to: "c", in: visible)
        #expect(gone == ["c"])
    }

    @Test func select_all_toggles_between_all_visible_and_none() {
        let visible = ["a", "b"]
        var selection: Set<String> = ["a", "hidden"]
        #expect(!selection.containsAll(of: visible))
        selection.toggleAll(in: visible)
        #expect(selection == ["a", "b"])
        selection.toggleAll(in: visible)
        #expect(selection.isEmpty)

        var empty: Set<String> = ["a"]
        empty.selectAll(in: [])
        #expect(empty == ["a"])
        #expect(!Set<String>().containsAll(of: []))
    }

    // MARK: Bulk writes

    @Test func bulk_complete_writes_once_and_one_undo_reverts_it() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let first = try vault.task("[agent] one", project: project)
        let second = try vault.task("[agent] two", project: project)
        await vault.store.load()

        let wrote = await vault.store.completeSelection([first, second])
        #expect(wrote)
        #expect(vault.store.items[first]?.isDone == true)
        #expect(vault.store.items[second]?.isDone == true)
        #expect(vault.store.toast == "2 tasks completed")
        #expect(vault.store.toastUndo != nil)

        await vault.store.undoFromToast(viaKeyboard: false)
        #expect(vault.store.items[first]?.isDone == false)
        #expect(vault.store.items[second]?.isDone == false)
        #expect(vault.store.toast == TasksCopy.changesUndone)
        #expect(vault.store.toastUndo == nil)
    }

    @Test func completing_an_all_done_selection_writes_nothing() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] done", project: project)
        await vault.store.load()
        _ = await vault.store.completeSelection([id])

        let wrote = await vault.store.completeSelection([id])
        #expect(!wrote)
        #expect(vault.store.toast == TasksCopy.alreadyAllComplete)
        #expect(vault.store.toastUndo == nil)
    }

    @Test func bulk_priority_and_due_follow_desktops_toasts() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let first = try vault.task("[agent] a", project: project)
        let second = try vault.task("[agent] b", project: project, due: "2026-01-20")
        await vault.store.load()

        _ = await vault.store.setPriority(of: [first, second], to: 3)
        #expect(vault.store.items[first]?.priority == 3)
        #expect(vault.store.toast == "Priority set to high for 2 tasks")

        _ = await vault.store.setPriority(of: [first], to: 0)
        #expect(vault.store.toast == "Priority removed for 1 task")

        _ = await vault.store.setDue(of: [first, second], preset: .tomorrow)
        #expect(vault.store.items[first]?.dueDate == "2026-01-15")
        #expect(vault.store.toast == "Due date set for 2 tasks")

        _ = await vault.store.setDue(of: [first], preset: .nextWeek)
        #expect(vault.store.items[first]?.dueDate == "2026-01-21")

        _ = await vault.store.setDue(of: [first], date: "2026-02-02", time: "09:30")
        #expect(vault.store.items[first]?.dueTime == "09:30")

        // A preset moves the day and keeps each task's own time (desktop).
        _ = await vault.store.setDue(of: [first, second], preset: .tomorrow)
        #expect(vault.store.items[first]?.dueDate == "2026-01-15")
        #expect(vault.store.items[first]?.dueTime == "09:30")
        #expect(vault.store.items[second]?.dueTime == nil)

        _ = await vault.store.setDue(of: [first, second], date: nil, time: "09:30")
        #expect(vault.store.items[first]?.dueDate == nil)
        #expect(vault.store.items[first]?.dueTime == nil)
        #expect(vault.store.toast == "Due date removed from 2 tasks")
    }

    @Test func bulk_move_and_status_name_their_target() async throws {
        let vault = try TasksTestVault()
        let source = try vault.project("Agent Test Source")
        let target = try vault.project("Agent Test Target")
        let id = try vault.task("[agent] move me", project: source)
        await vault.store.load()

        let statuses = vault.store.bulkStatuses([id])
        #expect(statuses.count == 3)
        let inProgress = try #require(statuses.first { $0.statusType == "in_progress" })
        _ = await vault.store.setStatus(of: [id], to: inProgress)
        #expect(vault.store.items[id]?.statusId == inProgress.id)
        #expect(vault.store.toast == "1 task moved to In Progress")

        let destination = try #require(vault.store.project(target))
        _ = await vault.store.move([id], to: destination)
        #expect(vault.store.items[id]?.projectId == target)
        #expect(vault.store.toast == "1 task moved to Agent Test Target")
        #expect(vault.store.bulkMoveTargets.contains { $0.id == target })
    }

    @Test func a_mixed_project_selection_offers_no_status() async throws {
        let vault = try TasksTestVault()
        let one = try vault.task("[agent] one", project: try vault.project("Agent Test One"))
        let two = try vault.task("[agent] two", project: try vault.project("Agent Test Two"))
        await vault.store.load()
        #expect(vault.store.bulkStatuses([one, two]).isEmpty)
    }

    @Test func archive_unarchive_and_delete_are_undoable() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] keep", project: project)
        let other = try vault.task("[agent] other", project: project)
        await vault.store.load()

        _ = await vault.store.archiveSelection([id, other])
        #expect(vault.store.items[id]?.archivedAt != nil)
        #expect(vault.store.toast == "2 tasks archived")

        await vault.store.update { $0.tab = .archived }
        #expect(vault.store.isArchivedScope)
        _ = await vault.store.unarchiveSelection([id])
        #expect(vault.store.items[id]?.archivedAt == nil)
        #expect(vault.store.toast == "1 task restored from archive")

        _ = await vault.store.deleteSelection([id, other])
        #expect(vault.store.items[id] == nil)
        #expect(vault.store.toast == "2 tasks deleted")

        await vault.store.undoFromToast(viaKeyboard: true)
        // A deleted task comes back under a new id (a tombstone is final).
        let restored = Set(vault.store.items.values.map(\.title))
        #expect(restored.isSuperset(of: ["[agent] keep", "[agent] other"]))
        #expect(vault.store.items[id] == nil)
        #expect(vault.store.toast == "Undone: 2 tasks deleted")
    }

    @Test func an_empty_or_vanished_selection_writes_nothing() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        #expect(!(await vault.store.deleteSelection([])))
        #expect(!(await vault.store.archiveSelection(["missing"])))
        #expect(vault.store.toast == nil)
    }

    // MARK: Toast

    @Test func a_toast_without_its_write_shows_no_undo_and_expires_by_key() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] toast", project: project)
        await vault.store.load()
        _ = await vault.store.completeSelection([id])
        let key = try #require(vault.store.toastKey)
        #expect(key.change != nil)

        vault.store.toast = TasksCopy.alreadyAllComplete
        #expect(vault.store.toastUndo == nil)
        vault.store.dismissToast(key)
        #expect(vault.store.toast == TasksCopy.alreadyAllComplete)

        let current = try #require(vault.store.toastKey)
        vault.store.dismissToast(current)
        #expect(vault.store.toast == nil)
    }

    @Test func the_delete_message_lists_five_titles_and_the_rest() {
        let titles = (1 ... 7).map { "T\($0)" }
        let message = TasksCopy.deleteMessage(titles: titles, total: 7)
        #expect(message.contains("You're about to delete 7 tasks:"))
        #expect(message.contains("• T5"))
        #expect(!message.contains("• T6"))
        #expect(message.contains("... and 2 more tasks"))
        #expect(TasksCopy.deleteTitle(1) == "Delete 1 task?")
    }
}
