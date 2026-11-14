import Foundation
import SwiftUI
import Testing

@testable import Memry

// #4380: the Day Panel and the note inspector share the page's width. One
// rail needs the reading measure beside it, two rails need room for both,
// and opening one closes the other where both cannot fit. On the journal
// page the panel follows the shown day; elsewhere it shows today until
// stepped.

@MainActor
@Suite("Side rails")
struct SideRailsTests {
    private let defaults = UserDefaults(suiteName: "SideRailsTests.\(UUID())") ?? .standard

    @Test func room_follows_the_page_width_size_class_and_text_size() {
        func room(_ width: CGFloat, regular: Bool = true, large: Bool = false) -> SideRailRoom {
            SideRailRoom(width: width, regular: regular, accessibilitySize: large)
        }
        #expect(room(1032) == .none, "13\" portrait keeps the note's measure")
        #expect(room(1086) == .one, "13\" landscape beside the page sidebar")
        #expect(room(1376) == .two, "13\" landscape with the page sidebar hidden")
        #expect(room(1376, regular: false) == .none, "compact width")
        #expect(room(1376, large: true) == .none, "accessibility text sizes")
    }

    @Test func opening_one_rail_closes_the_other_where_only_one_fits() {
        var open = SideRailsOpen(dayPanel: false, inspector: true)
        open.toggleDayPanel(in: .one)
        #expect(open == SideRailsOpen(dayPanel: true, inspector: false))
        open.toggleInspector(in: .one)
        #expect(open == SideRailsOpen(dayPanel: false, inspector: true))
    }

    @Test func both_rails_stay_open_where_both_fit() {
        var open = SideRailsOpen(dayPanel: false, inspector: true)
        open.toggleDayPanel(in: .two)
        #expect(open.dayPanelShown(in: .two) && open.inspectorShown(in: .two))
        open.toggleDayPanel(in: .two)
        #expect(open == SideRailsOpen(dayPanel: false, inspector: true))
    }

    @Test func a_window_that_shrinks_under_both_shows_the_panel_and_the_inspector_button_takes_over() {
        var open = SideRailsOpen(dayPanel: true, inspector: true)
        #expect(open.dayPanelShown(in: .one))
        #expect(!open.inspectorShown(in: .one))
        open.toggleInspector(in: .one)
        #expect(open == SideRailsOpen(dayPanel: false, inspector: true), "the waiting inspector shows on the first tap")
    }

    @Test func no_rail_shows_where_none_fits() {
        let open = SideRailsOpen(dayPanel: true, inspector: true)
        #expect(!open.dayPanelShown(in: .none))
        #expect(!open.inspectorShown(in: .none))
    }

    @Test func open_states_are_kept_per_device() {
        let rails = SideRails(defaults: defaults)
        rails.room = .one
        rails.toggleDayPanel()
        #expect(defaults.bool(forKey: SideRails.dayPanelKey))
        rails.toggleInspector()
        #expect(defaults.bool(forKey: NoteInspectorLayout.openKey))
        #expect(!defaults.bool(forKey: SideRails.dayPanelKey))

        let relaunched = SideRails(defaults: defaults)
        #expect(relaunched.open == SideRailsOpen(dayPanel: false, inspector: true))
    }

    @Test func on_the_journal_page_the_panel_follows_and_moves_the_shown_day() {
        let rails = SideRails(defaults: defaults)
        let journal = JournalRouter(today: "2099-03-04")
        journal.showDay("2099-03-01")
        rails.steppedDay = "2099-05-05"
        #expect(rails.dayPanelDate(following: journal.shownDay, today: "2099-03-04") == "2099-03-01")

        rails.step(to: "2099-03-02", today: "2099-03-04", journal: journal)
        #expect(journal.shownDay == "2099-03-02")
        #expect(rails.steppedDay == "2099-05-05", "the journal's day does not move the panel's own")
    }

    @Test func elsewhere_the_panel_shows_today_until_stepped() {
        let rails = SideRails(defaults: defaults)
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-04") == "2099-03-04")

        rails.step(to: "2099-03-05", today: "2099-03-04", journal: nil)
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-04") == "2099-03-05")

        rails.step(to: "2099-03-04", today: "2099-03-04", journal: nil)
        #expect(rails.steppedDay == nil, "back on today, the panel follows today again")
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-05") == "2099-03-05")
    }
}
