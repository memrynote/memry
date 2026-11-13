import Foundation
import Testing

@testable import Memry

// #4352, `DESIGN.md` › Tablet: Calendar at regular width opens on Week the
// first time and remembers the view after that; Month cells fit titled
// chips by their height (desktop `calendar-month-view.tsx`).

struct CalendarTabletTests {
    @Test func the_first_open_at_regular_width_shows_week() {
        var state = CalendarViewState()
        state.openFirst(at: .regular)
        #expect(state.view == .week)
    }

    @Test func compact_width_keeps_day_and_leaves_the_first_regular_open_to_week() {
        var state = CalendarViewState()
        state.openFirst(at: .compact)
        #expect(state.view == .day)
        state.openFirst(at: .regular)
        #expect(state.view == .week, "an iPad that first opened in Split View")
    }

    @Test func a_picked_view_stays_at_regular_width() throws {
        var picked = CalendarViewState()
        picked.view = .month
        picked.openFirst(at: .regular)
        #expect(picked.view == .month)

        // A state an older build saved always carries its view.
        let older = Data(#"{"view":"day","anchorDate":"2026-09-21"}"#.utf8)
        var saved = try JSONDecoder().decode(CalendarViewState.self, from: older)
        saved.openFirst(at: .regular)
        #expect(saved.view == .day)
    }

    @Test func an_unpicked_view_is_saved_without_a_view_key_and_reads_back_as_day() throws {
        var state = CalendarViewState()
        state.anchorDate = "2026-09-21"
        let data = try JSONEncoder().encode(state)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["view"] == nil)
        var reread = try JSONDecoder().decode(CalendarViewState.self, from: data)
        #expect(reread.view == .day)
        reread.openFirst(at: .regular)
        #expect(reread.view == .week)

        state.view = .year
        let picked = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        #expect(picked["view"] as? String == "year")
    }

    @Test func a_month_cell_counts_chip_rows_by_its_height() {
        #expect(CalendarMonthFit.slots(height: 140, label: 38, step: 22) == 4)
        #expect(CalendarMonthFit.slots(height: 30, label: 38, step: 22) == 0)
    }

    @Test func a_month_cell_shows_its_items_while_they_fit_and_more_for_the_rest() {
        #expect(CalendarMonthFit.cell(slots: 4, lanes: 0, items: 3, hiddenSpans: 0) == (3, 0))
        #expect(CalendarMonthFit.cell(slots: 4, lanes: 0, items: 4, hiddenSpans: 0) == (4, 0))
        // The "+N" line takes the last row.
        #expect(CalendarMonthFit.cell(slots: 4, lanes: 0, items: 6, hiddenSpans: 0) == (3, 3))
        #expect(CalendarMonthFit.cell(slots: 4, lanes: 1, items: 4, hiddenSpans: 0) == (2, 2))
        // A span in a lane the week hides counts in "+N".
        #expect(CalendarMonthFit.cell(slots: 2, lanes: 1, items: 0, hiddenSpans: 1) == (0, 1))
        #expect(CalendarMonthFit.cell(slots: 0, lanes: 0, items: 2, hiddenSpans: 0) == (0, 2))
    }

    @Test func a_week_shows_every_span_lane_that_fits_else_keeps_a_row_for_more() {
        #expect(CalendarMonthFit.lanes(2, slots: 4) == 2)
        #expect(CalendarMonthFit.lanes(5, slots: 4) == 3)
        #expect(CalendarMonthFit.lanes(1, slots: 0) == 0)
    }
}
