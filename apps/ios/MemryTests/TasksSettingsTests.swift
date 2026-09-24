import Foundation
import MemryCore
import Testing

@testable import Memry

// TP055: Settings > Tasks over the real core — each write lands through
// `Tasks`, the store holds what the core answered, and the page opens on the
// default view only when it has no state of its own.

@MainActor
@Suite("Tasks settings", .serialized)
struct TasksSettingsTests {
    @Test func a_fresh_vault_reads_desktops_defaults() async throws {
        let vault = try TasksTestVault()
        await vault.store.loadTaskSettings()

        let settings = try #require(vault.store.settings)
        #expect(settings.defaultProjectId == nil)
        #expect(settings.defaultSortOrder == TaskSettingsSortOrder.manual.rawValue)
        #expect(settings.defaultView == TaskSettingsDefaultView.all.rawValue)
        #expect(settings.staleInboxDays == 7)
    }

    @Test func the_default_project_is_set_and_cleared() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        await vault.store.load()

        await vault.store.setDefaultProject(project)
        #expect(vault.store.settings?.defaultProjectId == project)
        #expect(try vault.tasks.taskSettings().defaultProjectId == project)

        await vault.store.setDefaultProject(nil)
        #expect(vault.store.settings?.defaultProjectId == nil)
        #expect(try vault.tasks.taskSettings().defaultProjectId == nil)
    }

    @Test func sort_order_view_and_stale_days_write_through_the_core() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()

        await vault.store.setDefaultSortOrder(.priority)
        await vault.store.setDefaultView(.next7)
        await vault.store.setStaleInboxDays(30)

        let stored = try vault.tasks.taskSettings()
        #expect(stored.defaultSortOrder == "priority")
        #expect(stored.defaultView == "next7")
        #expect(stored.staleInboxDays == 30)
        #expect(vault.store.settings == stored)
    }

    @Test func an_out_of_range_stale_threshold_is_refused_and_not_shown() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()

        await vault.store.setStaleInboxDays(91)

        #expect(vault.store.settings?.staleInboxDays == 7)
        #expect(try vault.tasks.taskSettings().staleInboxDays == 7)
    }

    @Test func the_options_are_desktops_menus_in_order() {
        #expect(TaskSettingsSortOrder.allCases.map(\.rawValue) == ["manual", "dueDate", "priority", "createdAt"])
        #expect(TaskSettingsDefaultView.allCases.map(\.rawValue) == ["all", "today", "tomorrow", "next7"])
        #expect(TaskSettingsLimits.staleInboxDays == 1 ... 90)
        #expect(TasksCopy.settingsSortOrderLabel(.createdAt) == "Date Created")
        #expect(TasksCopy.settingsNoDefaultProject(inbox: "Inbox") == "No default (use Inbox)")
        #expect(TasksCopy.settingsStaleInboxValue(1) == "1 day")
    }

    @Test func the_opening_tab_follows_parseInternalTab() {
        let fresh = TasksViewState()
        #expect(TasksStore.openingTab(for: fresh, defaultView: "today") == .today)
        #expect(TasksStore.openingTab(for: fresh, defaultView: "all") == nil)
        #expect(TasksStore.openingTab(for: fresh, defaultView: "archived") == nil)
        #expect(TasksStore.openingTab(for: fresh, defaultView: nil) == nil)

        var touched = TasksViewState()
        touched.viewMode = .kanban
        #expect(TasksStore.openingTab(for: touched, defaultView: "today") == nil)
    }

    @Test func a_fresh_page_opens_on_the_default_view_once() async throws {
        let vault = try TasksTestVault()
        _ = try vault.tasks.setDefaultView(view: "tomorrow")
        await vault.store.load()

        await vault.store.openOnDefaultView()
        #expect(vault.store.state.tab == .tomorrow)

        await vault.store.update { $0.tab = .all }
        await vault.store.openOnDefaultView()
        #expect(vault.store.state.tab == .all)
    }

    @Test func a_page_with_its_own_state_keeps_it() async throws {
        let vault = try TasksTestVault()
        _ = try vault.tasks.setDefaultView(view: "today")
        await vault.store.update { $0.tab = .next7 }
        await vault.store.load()

        await vault.store.openOnDefaultView()
        #expect(vault.store.state.tab == .next7)
    }
}
