import Foundation
import MemryCore
import Testing

@testable import Memry

// TP049: the kanban board's columns, card placement, drops and per-column add,
// over a real scratch vault and the real core (clock 2026-01-14 12:00).

@MainActor
@Suite("Tasks kanban", .serialized)
struct TasksKanbanTests {
    private func lane(_ lanes: [KanbanLane], _ id: String) -> [String] {
        lanes.first { $0.id == id }?.tasks.map(\.id) ?? []
    }

    @Test func status_mode_without_a_project_falls_back_to_the_canonical_columns() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let open = try vault.task("[agent] open", project: project)
        let done = try vault.task("[agent] done", project: project)
        _ = try vault.tasks.complete(id: done, localNow: vault.store.localNow())
        vault.store.setKanbanMode(.status)
        await vault.store.load()

        #expect(vault.store.kanbanEffectiveMode == .canonical)
        let lanes = vault.store.kanbanLanes()
        #expect(lanes.map(\.id) == ["todo", "in_progress", "done"])
        #expect(lane(lanes, "todo") == [open])
        #expect(lane(lanes, "done") == [done])
        #expect(lanes.first { $0.id == "done" }?.column.isDoneColumn == true)
        #expect(lanes.first { $0.id == "done" }?.column.acceptsAdd == false)
    }

    @Test func status_mode_with_a_project_shows_its_statuses() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] card", project: project)
        await vault.store.load()
        await vault.store.update { $0.projectId = project }
        vault.store.setKanbanMode(.status)

        let statuses = try #require(vault.store.project(project)?.statuses)
        let lanes = vault.store.kanbanLanes()
        #expect(vault.store.kanbanEffectiveMode == .status)
        #expect(lanes.map(\.id) == statuses.sorted { $0.position < $1.position }.map(\.id))
        let todo = try #require(vault.store.items[id]?.statusId)
        #expect(lane(lanes, todo) == [id])
    }

    @Test func dropping_on_a_canonical_column_sets_the_tasks_own_status_of_that_type() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] move", project: project)
        await vault.store.load()
        let columns = vault.store.kanbanColumns()
        let progress = try #require(columns.first { $0.id == "in_progress" })

        #expect(await vault.store.kanbanMove(taskId: id, to: progress))
        #expect(vault.store.items[id]?.statusType == "in_progress")
        #expect(vault.store.undoable?.message == TasksCopy.kanbanMoved("In Progress"))
        #expect(await vault.store.kanbanMove(taskId: id, to: progress) == false)

        let done = try #require(columns.first { $0.id == "done" })
        #expect(await vault.store.kanbanMove(taskId: id, to: done))
        #expect(vault.store.items[id]?.isDone == true)
    }

    @Test func priority_columns_place_and_write_priority() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] high", project: project, priority: 3)
        vault.store.setKanbanMode(.priority)
        await vault.store.load()

        let lanes = vault.store.kanbanLanes()
        let expected = ["priority-urgent", "priority-high", "priority-medium", "priority-low", "priority-none"]
        #expect(lanes.map(\.id) == expected)
        #expect(lane(lanes, "priority-high") == [id])

        let urgent = try #require(lanes.first { $0.id == "priority-urgent" }?.column)
        #expect(await vault.store.kanbanMove(taskId: id, to: urgent))
        #expect(vault.store.items[id]?.priority == 4)
        #expect(vault.store.toast == TasksCopy.kanbanPrioritySet("Urgent"))
        await vault.store.undo()
        #expect(vault.store.items[id]?.priority == 3)
    }

    @Test func due_columns_use_the_cores_groups_and_parsed_dates() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let overdue = try vault.task("[agent] overdue", project: project, due: "2026-01-13")
        let today = try vault.task("[agent] today", project: project, due: "2026-01-14")
        let undated = try vault.task("[agent] undated", project: project)
        vault.store.setKanbanMode(.dueDate)
        await vault.store.load()

        let buckets = await vault.store.kanbanLoadDueBuckets()
        #expect(buckets[overdue] == "overdue")
        #expect(buckets[today] == "today")
        let lanes = vault.store.kanbanLanes(dueBuckets: buckets)
        #expect(lane(lanes, "due-overdue") == [overdue])
        #expect(lane(lanes, "due-today") == [today])
        #expect(lane(lanes, "due-noDueDate") == [undated])
        #expect(lanes.first { $0.id == "due-overdue" }?.column.acceptsAdd == false)
        #expect(lanes.first { $0.id == "due-overdue" }?.column.acceptsMove == false)

        #expect(vault.store.kanbanDueDate("tomorrow") == "2026-01-15")
        #expect(vault.store.kanbanDueDate("upcoming") == "2026-01-17")
        #expect(vault.store.kanbanDueDate("later") == "2026-01-28")
        #expect(vault.store.kanbanDueDate("noDueDate") == nil)

        let later = try #require(lanes.first { $0.id == "due-later" }?.column)
        #expect(await vault.store.kanbanMove(taskId: undated, to: later, dueBuckets: buckets))
        #expect(vault.store.items[undated]?.dueDate == "2026-01-28")
        let none = try #require(lanes.first { $0.id == "due-noDueDate" }?.column)
        #expect(await vault.store.kanbanMove(taskId: today, to: none, dueBuckets: buckets))
        #expect(vault.store.items[today]?.dueDate == nil)
    }

    @Test func project_columns_move_a_task_between_projects() async throws {
        let vault = try TasksTestVault()
        let first = try vault.project("Agent Test One")
        let second = try vault.project("Agent Test Two")
        let id = try vault.task("[agent] travel", project: first)
        vault.store.setKanbanMode(.project)
        await vault.store.load()

        let lanes = vault.store.kanbanLanes()
        #expect(lane(lanes, "project-\(first)") == [id])
        let target = try #require(lanes.first { $0.id == "project-\(second)" }?.column)
        #expect(await vault.store.kanbanMove(taskId: id, to: target))
        #expect(vault.store.items[id]?.projectId == second)
        #expect(vault.store.toast == TasksCopy.kanbanMoved("Agent Test Two"))
    }

    @Test func a_columns_add_presets_its_value() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        await vault.store.load()
        await vault.store.update { $0.projectId = project }

        vault.store.setKanbanMode(.priority)
        let high = try #require(vault.store.kanbanColumns().first { $0.id == "priority-high" })
        #expect(await vault.store.kanbanAdd(title: "  ", to: high) == false)
        #expect(await vault.store.kanbanAdd(title: "[agent] prioritized", to: high))
        let created = try #require(vault.store.ordered.first { $0.title == "[agent] prioritized" })
        #expect(created.priority == 3)
        #expect(created.projectId == project)

        vault.store.setKanbanMode(.dueDate)
        let tomorrow = try #require(vault.store.kanbanColumns().first { $0.id == "due-tomorrow" })
        #expect(await vault.store.kanbanAdd(title: "[agent] scheduled", to: tomorrow))
        #expect(vault.store.ordered.first { $0.title == "[agent] scheduled" }?.dueDate == "2026-01-15")

        vault.store.setKanbanMode(.status)
        let columns = vault.store.kanbanColumns()
        let progress = try #require(columns.first { $0.column(isType: "in_progress") })
        #expect(await vault.store.kanbanAdd(title: "[agent] started", to: progress))
        #expect(vault.store.ordered.first { $0.title == "[agent] started" }?.statusId == progress.id)
        let done = try #require(columns.first { $0.isDoneColumn })
        #expect(await vault.store.kanbanAdd(title: "[agent] refused", to: done) == false)
    }

    @Test func the_mode_persists_and_an_unknown_value_reads_as_status() async throws {
        let vault = try TasksTestVault()
        vault.store.setKanbanMode(.dueDate)
        #expect(vault.store.state.kanbanColumns == "dueDate")
        vault.store.state.kanbanColumns = "swimlanes"
        #expect(vault.store.kanbanMode == .status)
        #expect(KanbanColumnMode.pickable == [.status, .priority, .dueDate, .project])
    }
}

private extension KanbanColumn {
    func column(isType type: String) -> Bool {
        if case let .status(_, _, statusType, _) = target { return statusType == type }
        return false
    }
}
