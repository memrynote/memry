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
        for route in [SettingsRoute.account, .features, .appearance, .tasks] {
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
