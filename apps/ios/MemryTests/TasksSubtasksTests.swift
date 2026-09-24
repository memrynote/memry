import Foundation
import MemryCore
import Testing

@testable import Memry

// TP046: the subtask entry points and writes in `TasksStore+Subtasks.swift`,
// over a real scratch vault and the real core.

@MainActor
@Suite("Tasks subtasks", .serialized)
struct TasksSubtasksTests {
    @Test func completing_a_parent_with_open_subtasks_asks_first() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        _ = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        let item = try #require(vault.store.items[parent])
        await vault.store.requestComplete(item)

        #expect(vault.store.prompt == .completeParent(taskId: parent))
        #expect(vault.store.items[parent]?.isDone == false)
    }

    @Test func complete_all_closes_the_subtasks_with_the_parent() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.completeParent(parent, withSubtasks: true)

        #expect(vault.store.prompt == nil)
        #expect(vault.store.items[parent]?.isDone == true)
        #expect(vault.store.items[child]?.isDone == true)
        #expect(vault.store.toast == TasksCopy.subtaskParentAndSubtasksCompleted)
    }

    @Test func parent_only_keeps_the_subtasks_open_and_undoes_as_one() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let open = try vault.task("[agent] open", project: project, parent: parent)
        let done = try vault.task("[agent] done", project: project, parent: parent)
        _ = try vault.tasks.complete(id: done, localNow: vault.store.localNow())
        await vault.store.load()

        await vault.store.completeParent(parent, withSubtasks: false)

        #expect(vault.store.items[parent]?.isDone == true)
        #expect(vault.store.items[open]?.isDone == false)
        #expect(vault.store.items[done]?.isDone == true)
        #expect(vault.store.toast == TasksCopy.completed)

        await vault.store.undo()
        #expect(vault.store.items[parent]?.isDone == false)
        #expect(vault.store.items[open]?.isDone == false)
        #expect(vault.store.items[done]?.isDone == true)
    }

    @Test func completing_the_last_open_subtask_offers_the_parent() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let first = try vault.task("[agent] first", project: project, parent: parent)
        let second = try vault.task("[agent] second", project: project, parent: parent)
        await vault.store.load()

        await vault.store.requestComplete(try #require(vault.store.items[first]))
        #expect(vault.store.prompt == nil)

        await vault.store.requestComplete(try #require(vault.store.items[second]))
        #expect(vault.store.prompt == .allSubtasksDone(parentId: parent))

        await vault.store.completeParentAfterSubtasks(parent)
        #expect(vault.store.prompt == nil)
        #expect(vault.store.items[parent]?.isDone == true)
    }

    @Test func keeping_the_parent_open_clears_the_prompt() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.requestComplete(try #require(vault.store.items[child]))
        #expect(vault.store.prompt == .allSubtasksDone(parentId: parent))

        vault.store.keepParentOpen()
        #expect(vault.store.prompt == nil)
        #expect(vault.store.toast == TasksCopy.subtaskParentKeptOpen)
        #expect(vault.store.items[parent]?.isDone == false)
    }

    @Test func deleting_a_parent_asks_and_can_keep_the_subtasks() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.requestDelete(try #require(vault.store.items[parent]))
        #expect(vault.store.prompt == .deleteParent(taskId: parent))
        #expect(vault.store.items[parent] != nil)

        await vault.store.deleteParent(parent, keepSubtasks: true)
        #expect(vault.store.items[parent] == nil)
        #expect(vault.store.items[child]?.parentId == nil)
        #expect(vault.store.toast == TasksCopy.subtaskParentDeletedKeepSubtasks)
    }

    @Test func deleting_a_parent_with_all_removes_the_subtasks() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.deleteParent(parent, keepSubtasks: false)
        #expect(vault.store.items[parent] == nil)
        #expect(vault.store.items[child] == nil)
    }

    @Test func a_subtask_deletes_without_asking() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.requestDelete(try #require(vault.store.items[child]))
        #expect(vault.store.prompt == nil)
        #expect(vault.store.items[child] == nil)
        #expect(vault.store.toast == TasksCopy.subtaskDeleted)
    }

    @Test func inline_add_creates_a_subtask_in_the_parents_project() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        await vault.store.load()

        let added = await vault.store.addSubtask(to: try #require(vault.store.items[parent]), title: "  [agent] child ")
        #expect(added)
        let subtasks = vault.store.subtasks(of: parent)
        #expect(subtasks.map(\.title) == ["[agent] child"])
        #expect(subtasks.first?.projectId == project)
        #expect(vault.store.toast == TasksCopy.subtaskAdded)

        let blank = await vault.store.addSubtask(to: try #require(vault.store.items[parent]), title: "  ")
        #expect(!blank)
    }

    @Test func reorder_and_move_write_positions() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let first = try vault.task("[agent] a", project: project, parent: parent)
        let second = try vault.task("[agent] b", project: project, parent: parent)
        let third = try vault.task("[agent] c", project: project, parent: parent)
        await vault.store.load()

        await vault.store.reorderSubtasks([third, first, second])
        #expect(vault.store.subtasks(of: parent).map(\.id) == [third, first, second])

        await vault.store.moveSubtask(third, of: parent, by: 1)
        #expect(vault.store.subtasks(of: parent).map(\.id) == [first, third, second])
    }

    @Test func promote_makes_a_subtask_top_level() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.promoteToTask(try #require(vault.store.items[child]))
        #expect(vault.store.items[child]?.parentId == nil)
        #expect(vault.store.toast == TasksCopy.subtaskPromoted("[agent] child"))
    }

    @Test func picking_a_parent_in_another_project_moves_the_task_there() async throws {
        let vault = try TasksTestVault()
        let home = try vault.project("Agent Test Home")
        let away = try vault.project("Agent Test Away")
        let task = try vault.task("[agent] task", project: home)
        let parent = try vault.task("[agent] parent", project: away)
        await vault.store.load()

        await vault.store.makeSubtask(
            try #require(vault.store.items[task]),
            of: try #require(vault.store.items[parent])
        )
        #expect(vault.store.failure == nil)
        #expect(vault.store.items[task]?.parentId == parent)
        #expect(vault.store.items[task]?.projectId == away)

        await vault.store.undo()
        #expect(vault.store.items[task]?.parentId == nil)
        #expect(vault.store.items[task]?.projectId == home)
    }

    @Test func parent_candidates_are_top_level_same_project_first() async throws {
        let vault = try TasksTestVault()
        let home = try vault.project("Agent Test Home")
        let away = try vault.project("Agent Test Away")
        let task = try vault.task("[agent] task", project: home)
        let other = try vault.task("[agent] other", project: away)
        let sibling = try vault.task("[agent] sibling", project: home)
        _ = try vault.task("[agent] nested", project: home, parent: sibling)
        await vault.store.load()

        let item = try #require(vault.store.items[task])
        let ids = vault.store.parentCandidates(for: item).map(\.id)
        #expect(ids == [sibling, other])
        #expect(vault.store.parentCandidates(for: item, matching: "OTH").map(\.id) == [other])
    }

    @Test func bulk_writes_count_their_subtasks() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let first = try vault.task("[agent] a", project: project, parent: parent)
        let second = try vault.task("[agent] b", project: project, parent: parent)
        await vault.store.load()

        await vault.store.setPriorityForAllSubtasks(of: parent, priority: 3, includeCompleted: false)
        #expect(vault.store.items[first]?.priority == 3)
        #expect(vault.store.toast == TasksCopy.subtasksPrioritySet(2))

        await vault.store.setDueForAllSubtasks(of: parent, date: "2026-01-20", includeCompleted: false)
        #expect(vault.store.items[second]?.dueDate?.hasPrefix("2026-01-20") == true)
        #expect(vault.store.toast == TasksCopy.subtasksDueSet(2))

        await vault.store.completeAllSubtasks(of: parent)
        #expect(vault.store.subtasks(of: parent).allSatisfy { $0.isDone })
        #expect(vault.store.toast == TasksCopy.subtasksCompleted(2))
        #expect(vault.store.prompt == .allSubtasksDone(parentId: parent))
        vault.store.prompt = nil

        await vault.store.markAllSubtasksIncomplete(of: parent)
        #expect(vault.store.subtasks(of: parent).allSatisfy { !$0.isDone })
        #expect(vault.store.toast == TasksCopy.subtasksMarkedIncomplete(2))

        await vault.store.deleteAllSubtasks(of: parent)
        #expect(vault.store.subtasks(of: parent).isEmpty)
        #expect(vault.store.toast == TasksCopy.subtasksDeleted(2))
        #expect(vault.store.items[parent] != nil)
    }

    @Test func duplicate_asks_only_when_there_are_subtasks() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let lone = try vault.task("[agent] lone", project: project)
        let parent = try vault.task("[agent] parent", project: project)
        _ = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        await vault.store.requestDuplicate(try #require(vault.store.items[lone]))
        #expect(vault.store.ordered.contains { $0.title == "Copy of [agent] lone" })

        await vault.store.requestDuplicate(try #require(vault.store.items[parent]))
        #expect(vault.store.scratch[TasksStore.duplicateScratchKey] == parent)

        await vault.store.duplicate(parent, withSubtasks: true)
        #expect(vault.store.scratch[TasksStore.duplicateScratchKey] == nil)
        let copy = try #require(vault.store.ordered.first { $0.title == "Copy of [agent] parent" })
        #expect(vault.store.subtasks(of: copy.id).map(\.title) == ["[agent] child"])
    }
}
