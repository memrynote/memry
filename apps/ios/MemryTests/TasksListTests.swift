import Foundation
import MemryCore
import Testing

@testable import Memry

// TP040 / TP050: the list's layout over the real core's page answer, the
// device-local manual order, positions written by a move, and a drop on a
// due-date group.

@MainActor
@Suite("Tasks list", .serialized)
struct TasksListTests {
    private func scratchOrders() -> TaskListOrders {
        TaskListOrders(defaults: UserDefaults(suiteName: "task-orders-\(UUID().uuidString)") ?? .standard)
    }

    // MARK: Pure pieces

    @Test func a_move_reorders_the_top_level_rows() {
        let rows = ["a", "b", "c"].map { TaskListRow(id: $0, depth: 0) }
        let order = TaskReorder.topLevelOrder(rows: rows, moving: [2], destination: 0)
        #expect(order == ["c", "a", "b"])
        #expect(TaskReorder.positions(for: order) == [0, 1, 2])
    }

    @Test func a_parent_moves_past_another_parents_subtasks() {
        let rows = [
            TaskListRow(id: "a", depth: 0),
            TaskListRow(id: "b", depth: 0),
            TaskListRow(id: "b1", depth: 1),
            TaskListRow(id: "c", depth: 0)
        ]
        // Dropped between b and its subtask: lands after b.
        #expect(TaskReorder.topLevelOrder(rows: rows, moving: [0], destination: 2) == ["b", "a", "c"])
    }

    @Test func dragging_a_selected_row_moves_the_selected_set() {
        let rows = ["a", "b", "c", "d"].map { TaskListRow(id: $0, depth: 0) }
        let order = TaskReorder.topLevelOrder(rows: rows, moving: [0], destination: 4, selection: ["a", "c"])
        #expect(order == ["b", "d", "a", "c"])
    }

    @Test func the_saved_order_lays_over_the_cores_order() {
        let orders = scratchOrders()
        #expect(orders.ordered(["a", "b", "c"], section: "flat") == ["a", "b", "c"])
        orders.apply(["flat": ["c", "gone", "a"]])
        #expect(orders.ordered(["a", "b", "c"], section: "flat") == ["c", "a", "b"])
        orders.apply(["flat": nil])
        #expect(orders.order(for: "flat") == nil)
    }

    @Test func the_drag_payload_round_trips() {
        let text = TaskDragPayload.encode(["x", "y"])
        #expect(TaskDragPayload.decode(text) == ["x", "y"])
        #expect(TaskDragPayload.decode("plain text").isEmpty)
    }

    @Test func only_due_date_groups_take_a_drop() {
        #expect(TaskDueBucket(groupKey: "today", sortField: "dueDate") == .today)
        #expect(TaskDueBucket(groupKey: "overdue", sortField: "dueDate") == nil)
        #expect(TaskDueBucket(groupKey: "high", sortField: "priority") == nil)
    }

    // MARK: Layout over the core

    @Test func today_leads_with_an_overdue_section_when_the_list_is_flat() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let late = try vault.task("[agent] b late", project: project, due: "2026-01-10")
        let now = try vault.task("[agent] a now", project: project, due: "2026-01-14")
        await vault.store.load()
        await vault.store.update { state in
            state.tab = .today
            state.sort = TaskSortSpec(field: "title", direction: "asc")
        }

        let sections = vault.store.listSections(orders: scratchOrders())
        #expect(sections.map(\.id) == ["overdue", "flat"])
        #expect(sections.first?.rows.map(\.id) == [late])
        #expect(sections.last?.rows.map(\.id) == [now])
        // RD01: under an Overdue header the rest is named for the view.
        #expect(sections.last?.title == TasksCopy.tabTitle(.today))
        // A row in it does not repeat the day the header names.
        #expect(vault.store.sectionNamesDay(try #require(sections.last)))
        #expect(!vault.store.sectionNamesDay(try #require(sections.first)))
    }

    @Test func the_title_and_subtitle_name_the_view_scope_and_progress() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project("Agent Test Launch")
        _ = try vault.task("[agent] today", project: project, due: "2026-01-14")
        let done = try vault.task("[agent] done today", project: project, due: "2026-01-14")
        _ = try vault.tasks.complete(id: done, localNow: "2026-01-14T09:00:00")
        await vault.store.load()

        // Today counts what was completed today by the core's clock, which is
        // not the reference day, so only the open task counts here.
        await vault.store.selectTab(.today)
        #expect(vault.store.listTitle == TasksCopy.tabTitle(.today))
        #expect(vault.store.listSubtitle.hasSuffix(TasksCopy.subtitleDone(0, of: 1)))
        #expect(vault.store.listSubtitle.contains(TasksCopy.subtitleSeparator))

        await vault.store.selectTab(.all)
        await vault.store.selectProject(project)
        #expect(vault.store.listTitle == "Agent Test Launch")
        #expect(vault.store.listSubtitle == TasksCopy.subtitleDone(1, of: 2))

        await vault.store.updateFilters { $0.priorities = ["high"] }
        #expect(vault.store.listSubtitle.hasSuffix(TasksCopy.subtitleFiltered))
    }

    @Test func a_view_whose_tasks_are_all_done_is_empty_and_names_the_next_view() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let done = try vault.task("[agent] done", project: project, due: "2026-01-14")
        _ = try vault.task("[agent] tomorrow", project: project, due: "2026-01-15")
        _ = try vault.tasks.complete(id: done, localNow: "2026-01-14T09:00:00")
        await vault.store.load()
        await vault.store.selectTab(.today)

        #expect(vault.store.listEmptyState == .today)
        #expect(vault.store.listEmptyNext == TaskListEmptyNext(tab: .tomorrow, count: 1))
    }

    @Test func groups_follow_the_core_and_done_starts_collapsed() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let open = try vault.task("[agent] open", project: project, due: "2026-01-15")
        let finished = try vault.task("[agent] finished", project: project)
        await vault.store.load()
        let localNow = vault.store.localNow()
        await vault.store.perform(nil) { try $0.complete(id: finished, localNow: localNow).change }

        var sections = vault.store.listSections(orders: scratchOrders())
        #expect(sections.first?.id == "tomorrow")
        #expect(sections.first?.title == "Tomorrow")
        #expect(sections.first?.dropBucket == .tomorrow)
        #expect(sections.first?.rows.map(\.id) == [open])
        let done = try #require(sections.last)
        #expect(done.id == "done")
        #expect(done.isCollapsed)
        #expect(done.count == 1)
        #expect(done.rows.isEmpty)

        vault.store.toggleGroup("done")
        sections = vault.store.listSections(orders: scratchOrders())
        #expect(sections.last?.rows.map(\.id) == [finished])
        #expect(!vault.store.state.collapsedGroups.contains("done"))
    }

    // Goal rule 4: Tomorrow's lone "Tomorrow" group restates the title, so it
    // has no header (and so cannot fold its rows away); All keeps it.
    @Test func a_lone_group_that_is_the_view_has_no_header() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let open = try vault.task("[agent] open", project: project, due: "2026-01-15")
        await vault.store.load()
        vault.store.toggleGroup("tomorrow")

        await vault.store.selectTab(.tomorrow)
        let tomorrow = vault.store.listSections(orders: scratchOrders())
        #expect(tomorrow.first?.id == "tomorrow")
        #expect(tomorrow.first?.title == nil)
        #expect(tomorrow.first?.rows.map(\.id) == [open])

        await vault.store.selectTab(.all)
        #expect(vault.store.listSections(orders: scratchOrders()).first?.title == "Tomorrow")
    }

    @Test func subtasks_ride_one_level_in_under_their_parent() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let parent = try vault.task("[agent] parent", project: project)
        let child = try vault.task("[agent] child", project: project, parent: parent)
        await vault.store.load()

        let rows = vault.store.listSections(orders: scratchOrders()).flatMap(\.rows)
        #expect(rows == [TaskListRow(id: parent, depth: 0), TaskListRow(id: child, depth: 1)])
    }

    @Test func the_empty_states_follow_the_tab_and_the_filters() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        #expect(vault.store.listEmptyState == .all)

        await vault.store.selectTab(.next7)
        #expect(vault.store.listEmptyState == .next7)

        let project = try vault.project()
        _ = try vault.task("[agent] something", project: project, due: "2026-01-15")
        await vault.store.selectTab(.all)
        await vault.store.update { $0.filters.search = "nothing matches this" }
        await vault.store.refresh()
        #expect(vault.store.listEmptyState == .filtered)

        await vault.store.clearListFilters()
        #expect(vault.store.listEmptyState == nil)
    }

    @Test func todays_progress_counts_the_open_tasks_on_today() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        _ = try vault.task("[agent] today", project: project, due: "2026-01-14")
        await vault.store.load()
        #expect(vault.store.todayProgress == nil)

        await vault.store.selectTab(.today)
        #expect(vault.store.todayProgress?.done == 0)
        #expect(vault.store.todayProgress?.total == 1)
    }

    @Test func kanban_shows_on_the_all_tab_only() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        vault.store.setViewMode(.kanban)
        #expect(vault.store.showsKanban)
        await vault.store.selectTab(.today)
        #expect(!vault.store.showsKanban)
    }

    // MARK: Writes

    @Test func a_move_writes_positions_and_keeps_the_order() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let first = try vault.task("[agent] a", project: project)
        let second = try vault.task("[agent] b", project: project)
        let third = try vault.task("[agent] c", project: project)
        await vault.store.load()
        await vault.store.update { $0.sort = TaskSortSpec(field: "title", direction: "asc") }
        let orders = scratchOrders()
        let section = try #require(vault.store.listSections(orders: orders).first)
        #expect(section.rows.map(\.id) == [first, second, third])

        await vault.store.moveRows(in: section, from: [2], to: 0, orders: orders)

        #expect(vault.store.failure == nil)
        #expect(vault.store.listSections(orders: orders).first?.rows.map(\.id) == [third, first, second])
        #expect(vault.store.items[third]?.position == 0)
        #expect(vault.store.items[first]?.position == 1)
        #expect(vault.store.items[second]?.position == 2)
    }

    @Test func a_drop_on_a_date_group_reschedules_and_is_undoable() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let one = try vault.task("[agent] one", project: project, due: "2026-01-20")
        let two = try vault.task("[agent] two", project: project)
        await vault.store.load()

        await vault.store.reschedule([one, two], to: .tomorrow)
        #expect(vault.store.items[one]?.dueDate?.prefix(10) == "2026-01-15")
        #expect(vault.store.items[two]?.dueDate?.prefix(10) == "2026-01-15")
        #expect(vault.store.undoable?.message == TasksCopy.rescheduled(count: 2, target: "Tomorrow"))

        await vault.store.reschedule([one], to: .noDueDate)
        #expect(vault.store.items[one]?.dueDate == nil)

        await vault.store.undo()
        #expect(vault.store.items[one]?.dueDate?.prefix(10) == "2026-01-15")
    }

    @Test func leaving_a_tab_drops_the_saved_filter_it_showed() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        var config = SavedFilterConfig()
        config.filters.priorities = ["high"]
        let json = config.json
        let id = try #require(await vault.store.run { try $0.createSavedFilter(name: "High", configJson: json) })
        let filter = try #require(vault.store.savedFilters.first { $0.id == id })

        await vault.store.applyStarredFilter(filter)
        #expect(vault.store.activeSavedFilterId == id)
        #expect(vault.store.state.filters.priorities == ["high"])

        await vault.store.selectTab(.today)
        #expect(vault.store.activeSavedFilterId == nil)
        #expect(vault.store.state.filters == TaskFilterSpec())
    }
}
