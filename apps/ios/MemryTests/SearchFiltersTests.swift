import Foundation
import MemryCore
import Testing

@testable import Memry

// The search sheet's filters (#4321): a preset becomes the local day range
// the core filters on, and the scope and menu become one `SearchFilter`. The
// filtering itself is pinned in Rust (`domain_search_filter.rs`).

@Suite("Search filters")
struct SearchFiltersTests {
    /// UTC+3, as the staging vault's desktop runs.
    private func calendar(_ locale: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 3 * 3600) ?? .gmt
        calendar.locale = Locale(identifier: locale)
        return calendar
    }

    private func date(_ text: String) throws -> Date {
        try #require(ISO8601DateFormatter().date(from: text))
    }

    private func ms(_ text: String) throws -> Int64 {
        Int64(try date(text).timeIntervalSince1970 * 1000)
    }

    @Test func today_at_a_non_utc_offset_holds_an_edit_late_in_the_local_day() throws {
        let range = SearchDatePreset.today.range(now: try date("2026-11-12T07:00:00Z"), calendar: calendar("tr_TR"))

        #expect(range.fromMs == (try ms("2026-11-11T21:00:00Z")), "local midnight, not UTC's")
        #expect(range.toMs == (try ms("2026-11-12T21:00:00Z")) - 1)
        let lateEdit = try ms("2026-11-12T20:30:00Z")
        #expect((range.fromMs ... range.toMs).contains(lateEdit), "23:30 local is still today")
        #expect(!(range.fromMs ... range.toMs).contains(try ms("2026-11-12T21:00:00Z")))
    }

    @Test func the_week_starts_on_the_locales_first_weekday() throws {
        // Thursday 2026-11-12, local time.
        let now = try date("2026-11-12T07:00:00Z")

        let sunday = SearchDatePreset.thisWeek.range(now: now, calendar: calendar("en_US"))
        let monday = SearchDatePreset.thisWeek.range(now: now, calendar: calendar("tr_TR"))

        #expect(sunday.fromMs == (try ms("2026-11-07T21:00:00Z")), "en_US weeks start on Sunday")
        #expect(monday.fromMs == (try ms("2026-11-08T21:00:00Z")), "tr_TR weeks start on Monday")
        #expect(sunday.toMs == (try ms("2026-11-12T21:00:00Z")) - 1, "up to the end of today")
    }

    @Test func this_month_starts_on_the_first_local_day_of_the_month() throws {
        let lastMinute = SearchDatePreset.thisMonth.range(now: try date("2026-11-30T20:59:00Z"), calendar: calendar("tr_TR"))
        let firstMinute = SearchDatePreset.thisMonth.range(now: try date("2026-11-30T21:00:30Z"), calendar: calendar("tr_TR"))

        #expect(lastMinute.fromMs == (try ms("2026-10-31T21:00:00Z")), "23:59 on Nov 30 is still November")
        #expect(lastMinute.toMs == (try ms("2026-11-30T21:00:00Z")) - 1)
        #expect(firstMinute.fromMs == (try ms("2026-11-30T21:00:00Z")), "00:00 on Dec 1 is December")
        #expect(firstMinute.toMs == (try ms("2026-12-01T21:00:00Z")) - 1)
    }

    @Test func the_scope_and_the_menu_map_to_one_filter() throws {
        let now = try date("2026-11-12T07:00:00Z")
        let calendar = calendar("tr_TR")
        var filters = SearchFilters()
        #expect(filters.record(now: now, calendar: calendar) == nil, "nothing narrowed")

        filters.scope = .tasks
        filters.toggle(.today)
        filters.toggle(tag: "work")
        filters.toggle(tag: "searchtest")

        #expect(filters.isNarrowed)
        #expect(filters.record(now: now, calendar: calendar) == SearchFilter(
            types: [.task],
            modified: SearchDatePreset.today.range(now: now, calendar: calendar),
            tags: ["searchtest", "work"]
        ))

        filters.toggle(.today)
        filters.toggle(tag: "work")
        #expect(filters.record(now: now, calendar: calendar) == SearchFilter(types: [.task], modified: nil, tags: ["searchtest"]))

        filters.clear()
        #expect(!filters.isNarrowed)
        #expect(filters.scope == .tasks, "clearing the menu keeps the scope")
        filters.scope = .all
        #expect(filters.record(now: now, calendar: calendar) == nil)
    }
}
