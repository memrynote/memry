import Foundation
import SwiftUI
import Testing

@testable import Memry

// Compact: Home and Notes pinned, two slots in desktop's rail order, the rest
// behind Menu. Regular: every page in desktop's rail order, then Notes.

@MainActor
@Suite("Vault tab layout")
struct VaultTabLayoutTests {
    private let all: (VaultTab) -> Bool = { _ in true }

    @Test func a_never_dragged_rail_uses_the_mobile_default() {
        let layout = VaultTabLayout(savedOrder: [], isShown: all)
        #expect(layout.bar == [.home, .notes, .tasks, .journal])
        #expect(layout.menu == [.inbox, .calendar])
    }

    @Test func desktop_order_places_the_slots_and_skips_pages_the_phone_lacks() {
        let saved = ["graph", "home", "calendar", "inbox", "canvas", "tasks", "journal"]
        let layout = VaultTabLayout(savedOrder: saved, isShown: all)
        #expect(layout.bar == [.home, .notes, .calendar, .inbox])
        #expect(layout.menu == [.tasks, .journal])
    }

    @Test func a_page_missing_from_an_older_order_keeps_its_default_rank() {
        let layout = VaultTabLayout(savedOrder: ["journal", "inbox"], isShown: all)
        #expect(layout.bar == [.home, .notes, .journal, .inbox])
        #expect(layout.menu == [.tasks, .calendar])
    }

    @Test func a_module_turned_off_gives_its_slot_to_the_next_page() {
        let layout = VaultTabLayout(savedOrder: [], isShown: { $0 != .journal })
        #expect(layout.bar == [.home, .notes, .tasks, .inbox])
        #expect(layout.menu == [.calendar])
    }

    @Test func a_page_behind_menu_selects_menu_and_shows_under_it() {
        let layout = VaultTabLayout(savedOrder: [], isShown: all)
        #expect(layout.barSelection(for: .inbox) == .more)
        #expect(layout.menuContent(for: .inbox) == .inbox)
        #expect(layout.barSelection(for: .tasks) == .tasks)
        #expect(layout.menuContent(for: .tasks) == .more, "Menu falls back to Settings")
    }

    // MARK: Regular width (the iPad sidebar)

    @Test func the_sidebar_lists_every_page_in_desktops_default_rail_then_notes() {
        let layout = VaultTabLayout(savedOrder: [], width: .regular, isShown: all)
        #expect(layout.bar == [.home, .inbox, .journal, .calendar, .tasks, .notes])
        #expect(layout.menu.isEmpty)
    }

    @Test func the_sidebar_follows_the_dragged_rail_and_skips_pages_ios_lacks() {
        let saved = ["graph", "tasks", "calendar", "canvas", "home", "inbox", "journal"]
        let layout = VaultTabLayout(savedOrder: saved, width: .regular, isShown: all)
        #expect(layout.bar == [.tasks, .calendar, .home, .inbox, .journal, .notes])
    }

    @Test func a_page_an_older_rail_lacks_lands_after_its_default_neighbour() {
        // Desktop's `resolveSidebarSectionOrder`: Calendar follows Journal.
        let layout = VaultTabLayout(savedOrder: ["tasks", "journal", "home", "inbox"], width: .regular, isShown: all)
        #expect(layout.bar == [.tasks, .journal, .calendar, .home, .inbox, .notes])
    }

    @Test func a_page_turned_off_leaves_the_sidebar() {
        let layout = VaultTabLayout(savedOrder: [], width: .regular, isShown: { $0 != .inbox && $0 != .calendar })
        #expect(layout.bar == [.home, .journal, .tasks, .notes])
    }

    @Test func every_shown_page_selects_its_own_row_and_settings_selects_settings() {
        let layout = VaultTabLayout(savedOrder: [], width: .regular, isShown: all)
        for page in layout.bar {
            #expect(layout.barSelection(for: page) == page)
        }
        #expect(layout.barSelection(for: .more) == .more)
        #expect(layout.menuContent(for: .more) == .more)
    }

    @Test func the_sidebar_needs_regular_width_and_regular_height() {
        #expect(LayoutWidth(horizontal: .regular, vertical: .regular) == .regular)
        #expect(LayoutWidth(horizontal: .compact, vertical: .regular) == .compact, "iPad Split View")
        #expect(LayoutWidth(horizontal: .regular, vertical: .compact) == .compact, "large iPhone in landscape")
        #expect(LayoutWidth(horizontal: nil, vertical: nil) == .compact)
    }

    /// A portrait window would open with the sidebar over the page, and a
    /// link that routes there (`memry://calendar`) cannot close it.
    @Test func the_sidebar_is_pinned_only_in_a_landscape_window() {
        #expect(VaultTabLayout.placement(for: CGSize(width: 1376, height: 1032)) == .sidebar)
        #expect(VaultTabLayout.placement(for: CGSize(width: 1032, height: 1376)) == .automatic)
    }
}
