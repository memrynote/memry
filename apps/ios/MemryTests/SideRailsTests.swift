import Foundation
import SwiftUI
import Testing

@testable import Memry

// #4380: the Day Panel and the note inspector share the page's width. One
// rail needs the reading measure beside it, two rails need room for both,
// and opening one closes the other where both cannot fit. The Journal keeps
// its day rail's rule: the panel fits at any regular width there. Each page
// answers from its own room and its own open state. On the journal page the
// panel follows the shown day; elsewhere it shows today until stepped. On
// the journal page the panel starts open and keeps its own open state.

@MainActor
@Suite("Side rails")
final class SideRailsTests {
    private let suites = ["SideRailsTests.\(UUID())", "SideRailsTests.settings.\(UUID())"]
    private let defaults: UserDefaults
    private let settings: LocalSettings

    init() throws {
        defaults = try #require(UserDefaults(suiteName: suites[0]))
        settings = LocalSettings(defaults: try #require(UserDefaults(suiteName: suites[1])))
    }

    deinit {
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
    }

    private func rails(_ room: SideRailRoom = .one, on pages: [VaultTab] = [.home, .notes, .inbox, .tasks, .journal, .calendar, .more]) -> SideRails {
        let rails = SideRails(defaults: defaults, settings: settings)
        for page in pages { rails.measured(room, on: page) }
        return rails
    }

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

    @Test func on_the_journal_the_panel_fits_at_any_regular_width() {
        func room(_ width: CGFloat, regular: Bool = true, large: Bool = false) -> SideRailRoom {
            SideRailRoom(width: width, regular: regular, accessibilitySize: large, onJournal: true)
        }
        #expect(room(744) == .one, "iPad mini portrait, as the Journal's day rail did")
        #expect(room(1032) == .one, "13\" portrait")
        #expect(room(1376, regular: false) == .none, "compact width")
        #expect(room(1376, large: true) == .none, "accessibility text sizes")
    }

    @Test func calendar_and_a_journal_turned_off_have_no_panel() {
        let rails = rails()
        #expect(!rails.dayPanelFits(on: .calendar), "Calendar has its own agenda column")
        #expect(rails.dayPanelFits(on: .tasks))

        _ = settings.set(.journal, on: false)
        #expect(!rails.dayPanelFits(on: .tasks))
        #expect(!rails.dayPanelFits(on: .journal))
    }

    @Test func with_the_journal_off_a_panel_left_open_does_not_hold_the_inspector_back() {
        let rails = rails()
        rails.toggleDayPanel(on: .notes)
        _ = settings.set(.journal, on: false)
        rails.toggleInspector()
        #expect(rails.inspectorShown)
    }

    @Test func each_page_reads_its_own_room() {
        let rails = rails(.none, on: [.notes])
        rails.measured(.one, on: .journal)
        #expect(rails.dayPanelShown(on: .journal))
        #expect(!rails.dayPanelFits(on: .notes), "the Journal's room does not seat the panel on Notes")
        #expect(!rails.inspectorFits)
    }

    /// The Notes page reads its own state while the Journal is the selected
    /// page, so returning to Notes beside an open note does not collapse the
    /// list for a panel that is open only on the Journal.
    @Test func notes_never_reads_the_journals_open_state() {
        let rails = rails()
        #expect(rails.dayPanelShown(on: .journal), "open by default on the Journal")
        #expect(!rails.dayPanelShown(on: .notes), "closed on Notes whichever page is selected")
    }

    @Test func opening_one_rail_closes_the_other_where_only_one_fits() {
        var open = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true)
        open.toggleDayPanel(in: .one, onJournal: false)
        #expect(open == SideRailsOpen(dayPanel: true, journalDayPanel: true, inspector: false))
        open.toggleInspector(in: .one, panelRoom: .one)
        #expect(open == SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true))
    }

    @Test func both_rails_stay_open_where_both_fit() {
        var open = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true)
        open.toggleDayPanel(in: .two, onJournal: false)
        #expect(open.dayPanelShown(in: .two, onJournal: false) && open.inspectorShown(in: .two, panelRoom: .two))
        open.toggleDayPanel(in: .two, onJournal: false)
        #expect(open == SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true))
    }

    @Test func a_window_that_shrinks_under_both_shows_the_panel_and_the_inspector_button_takes_over() {
        var open = SideRailsOpen(dayPanel: true, journalDayPanel: true, inspector: true)
        #expect(open.dayPanelShown(in: .one, onJournal: false))
        #expect(!open.inspectorShown(in: .one, panelRoom: .one))
        open.toggleInspector(in: .one, panelRoom: .one)
        #expect(open == SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true), "the waiting inspector shows on the first tap")
    }

    @Test func no_rail_shows_where_none_fits() {
        let open = SideRailsOpen(dayPanel: true, journalDayPanel: true, inspector: true)
        #expect(!open.dayPanelShown(in: .none, onJournal: false))
        #expect(!open.inspectorShown(in: .none, panelRoom: .none))
    }

    @Test func open_states_are_kept_per_device() {
        let rails = rails()
        rails.toggleDayPanel(on: .tasks)
        #expect(defaults.bool(forKey: SideRails.dayPanelKey))
        rails.toggleInspector()
        #expect(defaults.bool(forKey: NoteInspectorLayout.openKey))
        #expect(!defaults.bool(forKey: SideRails.dayPanelKey))

        let relaunched = SideRails(defaults: defaults, settings: settings)
        #expect(relaunched.open == SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true))
    }

    @Test func on_the_journal_page_the_panel_starts_open_and_elsewhere_closed() {
        let rails = rails()
        #expect(!rails.dayPanelShown(on: .tasks), "closed by default off the Journal, as on desktop")
        #expect(rails.dayPanelShown(on: .journal), "open by default on the Journal, as its day rail was")
    }

    @Test func closing_the_panel_on_the_journal_keeps_it_closed_there_only() {
        let rails = rails()
        rails.toggleDayPanel(on: .journal)
        #expect(!rails.dayPanelShown(on: .journal))

        rails.toggleDayPanel(on: .tasks)
        #expect(rails.dayPanelShown(on: .tasks), "the other pages keep their own state")

        let relaunched = SideRails(defaults: defaults, settings: settings)
        relaunched.measured(.one, on: .journal)
        relaunched.measured(.one, on: .tasks)
        #expect(!relaunched.dayPanelShown(on: .journal), "closed on the Journal stays closed after relaunch")
        #expect(relaunched.dayPanelShown(on: .tasks))
    }

    @Test func the_journal_panel_leaves_the_inspector_alone() {
        var open = SideRailsOpen(dayPanel: false, journalDayPanel: false, inspector: true)
        open.toggleDayPanel(in: .one, onJournal: true)
        #expect(open == SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true))
        #expect(open.inspectorShown(in: .one, panelRoom: .one), "the inspector beside a note is untouched")
    }

    @Test func the_panel_follows_the_journals_shown_day_and_elsewhere_today_until_stepped() {
        let rails = rails()
        rails.steppedDay = "2099-05-05"
        #expect(rails.dayPanelDate(following: "2099-03-01", today: "2099-03-04") == "2099-03-01")
        rails.steppedDay = nil
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-04") == "2099-03-04")

        rails.step(to: "2099-03-05", today: "2099-03-04")
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-04") == "2099-03-05")

        rails.step(to: "2099-03-04", today: "2099-03-04")
        #expect(rails.steppedDay == nil, "back on today, the panel follows today again")
        #expect(rails.dayPanelDate(following: nil, today: "2099-03-05") == "2099-03-05")
    }
}
