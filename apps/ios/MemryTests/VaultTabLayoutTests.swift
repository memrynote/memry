import Foundation
import Testing

@testable import Memry

// The tab bar: Home and Notes pinned, two slots in desktop's rail order,
// the rest behind Menu.

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
}
