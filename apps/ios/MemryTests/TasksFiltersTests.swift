import Foundation
import MemryCore
import Testing

@testable import Memry

// TP048: filters, quick presets, chips, group-by, collapsed groups and saved
// filters over the real core.

@MainActor
@Suite("Tasks filters", .serialized)
struct TasksFiltersTests {
    @Test func a_filter_edit_narrows_the_page_through_the_core() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let high = try vault.task("[agent] high", project: project, priority: 3)
        _ = try vault.task("[agent] low", project: project, priority: 1)
        await vault.store.load()

        await vault.store.updateFilters { $0.priorities = ["high"] }

        #expect(vault.store.state.filters.priorities == ["high"])
        #expect(vault.store.result?.taskIds == [high])
    }

    @Test func a_quick_preset_replaces_the_filters_and_toggles_off() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        await vault.store.updateFilters { $0.search = "milk" }

        await vault.store.applyQuickPreset(.highPriority)
        #expect(vault.store.state.filters.priorities == ["urgent", "high"])
        #expect(vault.store.state.filters.search.isEmpty)
        #expect(TaskFilterPreset.active(in: vault.store.state.filters) == .highPriority)

        await vault.store.applyQuickPreset(.highPriority)
        #expect(vault.store.state.filters == TaskFilterSpec())
    }

    @Test func presets_match_as_desktops_quick_filters_do() {
        var filters = TaskFilterPreset.overdue.filters
        #expect(TaskFilterPreset.active(in: filters) == .overdue)
        filters.completion = "all"
        #expect(TaskFilterPreset.active(in: filters) == .overdue)
        filters.tags = ["x"]
        #expect(TaskFilterPreset.active(in: filters) == nil)
        #expect(TaskFilterPreset.active(in: TaskFilterSpec()) == nil)
        #expect(TaskFilterPreset.noDueDate.filters.dueDate.type == "none")
        #expect(TaskFilterPreset.repeating.filters.repeatType == "repeating")
    }

    @Test func chips_follow_desktops_order_and_clear_one_dimension() throws {
        var filters = TaskFilterSpec()
        filters.search = "milk"
        filters.priorities = ["urgent"]
        filters.dueDate = DueDateFilterSpec(type: "overdue")
        filters.completion = "archived"
        let chips = TaskFilterChip.chips(for: filters, projects: [])
        #expect(chips.map(\.dimension) == [.priority, .dueDate, .search, .completion])
        #expect(chips.first?.value == "Urgent")
        #expect(chips.last?.value == "Archived")

        let due = try #require(chips.first { $0.dimension == .dueDate })
        let cleared = due.cleared(filters)
        #expect(cleared.dueDate == DueDateFilterSpec())
        #expect(cleared.search == "milk")
    }

    @Test func a_custom_range_is_written_as_ordered_day_keys() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        let later = TasksTestVault.referenceNow.addingTimeInterval(86400 * 3)
        await vault.store.setDueFilterRange(from: later, to: TasksTestVault.referenceNow)

        let due = vault.store.state.filters.dueDate
        #expect(due.type == "custom")
        #expect(due.customStart == "2026-01-14")
        #expect(due.customEnd == "2026-01-17")
        #expect(TaskFilterOptions.dueLabel(due).contains("–"))
    }

    @Test func tags_toggle_case_insensitively_and_list_task_tags() async throws {
        #expect(TasksStore.toggledTag("Work", in: ["work"]).isEmpty)
        #expect(TasksStore.toggledTag("home", in: ["work"]) == ["work", "home"])
        #expect(TasksStore.toggled("a", in: ["a", "b"]) == ["b"])

        let vault = try TasksTestVault()
        let project = try vault.project()
        let id = try vault.task("[agent] tagged", project: project)
        _ = try vault.tasks.setTags(id: id, tags: ["test", "work"])
        await vault.store.load()
        #expect(vault.store.filterTags.map(\.tag) == ["test", "work"])
        #expect(vault.store.filterTags.first?.count == 1)
    }

    @Test func group_by_and_collapsed_groups_persist_in_the_view_state() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        await vault.store.setSortField("priority")
        await vault.store.setSortDirection("desc")
        #expect(vault.store.state.sort == TaskSortSpec(field: "priority", direction: "desc"))

        #expect(vault.store.isGroupCollapsed("done"))
        vault.store.toggleGroupCollapsed("priority.high")
        #expect(vault.store.isGroupCollapsed("priority.high"))
        vault.store.toggleGroupCollapsed("priority.high")
        #expect(!vault.store.isGroupCollapsed("priority.high"))
    }

    @Test func saved_filter_names_follow_the_cores_rule() {
        #expect(!TaskFilterOptions.isValidSavedFilterName("   "))
        #expect(TaskFilterOptions.isValidSavedFilterName("Mine"))
        #expect(TaskFilterOptions.isValidSavedFilterName(String(repeating: "a", count: 100)))
        #expect(!TaskFilterOptions.isValidSavedFilterName(String(repeating: "a", count: 101)))
    }

    @Test func save_apply_rename_star_reorder_and_delete_a_saved_filter() async throws {
        let vault = try TasksTestVault()
        let store = vault.store
        await store.load()
        await store.updateFilters { $0.priorities = ["high"] }
        await store.setSortField("priority")

        #expect(await store.saveCurrentFilter(name: "  High  "))
        let saved = try #require(store.savedFilters.first)
        #expect(saved.name == "High")
        #expect(store.activeSavedFilterId == saved.id)
        let config = SavedFilterConfig.decode(saved.configJson)
        #expect(config.filters.priorities == ["high"])
        #expect(config.sort?.field == "priority")

        await store.updateFilters { $0.priorities = ["low"] }
        #expect(store.activeSavedFilterId == nil)
        await store.applySavedFilter(saved)
        #expect(store.state.filters.priorities == ["high"])
        #expect(store.activeSavedFilterId == saved.id)
        #expect(store.toast == TasksCopy.filterApplied("High"))

        await store.applySavedFilter(saved)
        #expect(store.state.filters == TaskFilterSpec())
        #expect(store.activeSavedFilterId == nil)

        #expect(await store.renameSavedFilter(saved.id, to: "Urgent work"))
        await store.toggleSavedFilterStar(try #require(store.savedFilters.first))
        #expect(store.savedFilters.first?.name == "Urgent work")
        #expect(store.savedFilters.first?.starred == true)

        await store.updateFilters { $0.tags = ["x"] }
        #expect(await store.saveCurrentFilter(name: "Second"))
        #expect(store.savedFilters.map(\.name) == ["Urgent work", "Second"])
        await store.moveSavedFilters(from: IndexSet(integer: 1), to: 0)
        #expect(store.savedFilters.map(\.name) == ["Second", "Urgent work"])

        let second = try #require(store.savedFilters.first)
        await store.deleteSavedFilter(second.id)
        #expect(store.savedFilters.map(\.name) == ["Urgent work"])
        #expect(store.state.filters == TaskFilterSpec())
        #expect(store.toast == TasksCopy.filterDeleted)
        #expect(store.failure == nil)
    }

    @Test func an_invalid_name_writes_nothing() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        await vault.store.updateFilters { $0.search = "x" }
        #expect(await vault.store.saveCurrentFilter(name: " ") == false)
        #expect(vault.store.savedFilters.isEmpty)
    }
}
