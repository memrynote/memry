import Foundation
import MemryCore
import Testing

@testable import Memry

// TP030-TP033: the store over the real core, the route into a task, the due
// labels and the copy.

@MainActor
@Suite("Tasks store", .serialized)
struct TasksStoreTests {
    @Test func load_reads_tasks_projects_and_the_page_query() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let today = try vault.task("[agent] today", project: project, due: "2026-01-14")
        _ = try vault.task("[agent] later", project: project, due: "2026-02-01")

        await vault.store.update { $0.tab = .today }
        await vault.store.load()

        #expect(vault.store.failure == nil)
        #expect(vault.store.items.count == 2)
        #expect(vault.store.projects.contains { $0.id == project })
        #expect(vault.store.result?.taskIds == [today])
        #expect(vault.store.result?.counts.all == 2)
    }

    @Test func a_write_refreshes_and_is_undoable() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] finish", project: project)
        await vault.store.load()

        let now = vault.store.localNow()
        await vault.store.perform(TasksCopy.completed) { core in
            try core.complete(id: id, localNow: now).change
        }
        #expect(vault.store.items[id]?.isDone == true)
        #expect(vault.store.undoable?.message == TasksCopy.completed)

        await vault.store.undo()
        #expect(vault.store.items[id]?.isDone == false)
        #expect(vault.store.undoable == nil)
    }

    @Test func a_failed_write_is_reported_not_swallowed() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        await vault.store.perform("x") { core in try core.setTitle(id: "missing", title: "t") }
        #expect(vault.store.failure != nil)
    }

    @Test func the_view_state_survives_a_new_store() async throws {
        let defaults = UserDefaults(suiteName: "tasks-state-\(UUID().uuidString)") ?? .standard
        let vault = try TasksTestVault()
        let first = TasksStore(core: vault.tasks, filler: nil, vaultId: "v", defaults: defaults)
        first.state.tab = .next7
        first.state.viewMode = .kanban
        let second = TasksStore(core: vault.tasks, filler: nil, vaultId: "v", defaults: defaults)
        #expect(second.state.tab == .next7)
        #expect(second.state.viewMode == .kanban)
    }

    @Test func the_router_opens_a_task_in_the_tasks_tab() {
        let router = TasksRouter()
        router.openTask("abc")
        #expect(router.selectedTab == .tasks)
        #expect(router.path == [.task("abc")])
    }

    @Test func due_labels_follow_desktops_relative_days() {
        let today = "2026-01-14"
        #expect(TaskDueLabel.make(date: "2026-01-14", time: nil, today: today, isDone: false)?.tone == .today)
        #expect(TaskDueLabel.make(date: "2026-01-15", time: nil, today: today, isDone: false)?.text == "Tomorrow")
        #expect(TaskDueLabel.make(date: "2026-01-13", time: nil, today: today, isDone: false)?.tone == .overdue)
        #expect(TaskDueLabel.make(date: "2026-01-01", time: nil, today: today, isDone: true)?.tone == .done)
    }

    @Test func group_keys_read_as_desktops_labels() {
        #expect(TasksCopy.groupLabel("dueDate.upcoming") == "This Week")
        #expect(TasksCopy.groupLabel("status.in_progress") == "In Progress")
        #expect(TasksCopy.groupLabel("future.key") == "future.key")
        #expect(TasksCopy.priorityLabel(4) == "Urgent")
    }

    @Test func filter_specs_are_desktops_json() throws {
        var spec = TaskFilterSpec()
        spec.priorities = ["high"]
        let decoded = try JSONDecoder().decode(TaskFilterSpec.self, from: Data(#"{"priorities":["high"]}"#.utf8))
        #expect(decoded == spec)
        #expect(decoded.activeCount == 1)
        #expect(decoded.completion == "active")
    }
}
