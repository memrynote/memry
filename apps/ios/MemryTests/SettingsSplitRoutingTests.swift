import SwiftUI
import Testing

@testable import Memry

// #4348: at regular width Settings is a split view, so "… › settings" links
// select a root row and push a page under one over it; a stack keeps every
// page over the root list (spec 006 ST20).

@MainActor
@Suite("Settings split routing")
struct SettingsSplitRoutingTests {
    @Test func a_stack_pushes_the_page_over_the_root() {
        let router = TasksRouter()
        router.openSettings(.devices)
        #expect(router.selectedTab == .more)
        #expect(router.settingsPath.count == 1)
        #expect(router.settingsPage == nil)
    }

    @Test func the_split_view_selects_a_root_row_without_a_push() {
        let router = TasksRouter()
        router.setSettingsSplit(true)
        let rows = SettingsRootRows(account: .free(email: nil), isOn: { _ in true }).routes
        #expect(rows.count == 13)
        for route in rows {
            router.openSettings(route)
            #expect(router.selectedTab == .more)
            #expect(router.settingsPage == route)
            #expect(router.settingsPath.isEmpty)
        }
    }

    @Test func the_split_view_pushes_a_subpage_over_its_row() {
        let router = TasksRouter()
        router.setSettingsSplit(true)
        let rows: [(SettingsRoute, SettingsRoute)] = [
            (.devices, .account), (.storage, .account), (.font, .appearance),
            (.newNotesFolder, .general), (.template("t1"), .templates), (.property("status"), .properties),
        ]
        for (route, row) in rows {
            router.openSettings(route)
            #expect(router.settingsPage == row)
            #expect(router.settingsPath.count == 1)
        }
    }

    @Test func the_local_vault_opens_on_general_with_no_account_row() {
        let rows = SettingsRootRows(account: .local, isOn: { _ in true })
        #expect(!rows.routes.contains(.account))
        #expect(rows.page(nil) == .general)
        #expect(rows.page(.devices.section) == .general)
        let signedIn = SettingsRootRows(account: .free(email: nil), isOn: { _ in true })
        #expect(signedIn.page(nil) == .account, "desktop's default section")
    }

    @Test func a_page_whose_module_is_off_falls_back_to_the_first_row() {
        let rows = SettingsRootRows(account: .free(email: nil), isOn: { $0 != .tasks && $0 != .inbox })
        #expect(rows.page(.tasks) == .account)
        #expect(rows.page(.inbox) == .account)
        #expect(rows.page(.appearance) == .appearance)
        let local = SettingsRootRows(account: .local, isOn: { $0 != .tasks })
        #expect(local.page(.tasks) == .general)
    }

    @Test func opening_the_root_in_the_split_view_keeps_the_selected_row() {
        let router = TasksRouter()
        router.setSettingsSplit(true)
        router.openSettings(.devices)
        router.openSettings(.root)
        #expect(router.settingsPage == .account)
        #expect(router.settingsPath.isEmpty)
    }

    @Test func narrowing_to_a_stack_keeps_the_selected_page() {
        let router = TasksRouter()
        router.setSettingsSplit(true)
        router.openSettings(.devices)
        router.setSettingsSplit(false)
        #expect(router.settingsPath.count == 1)
        router.setSettingsSplit(true)
        #expect(router.settingsPage == .account)
        #expect(router.settingsPath.isEmpty)
    }
}
