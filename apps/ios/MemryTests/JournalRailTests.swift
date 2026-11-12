import Foundation
import MemryCore
import Testing

@testable import Memry

// #4351: what the Journal rail and the regular-width year grid read. "On
// this day" over a scratch vault and the real core, with desktop's same-day
// rule (`packages/domain-notes/src/journal/same-day.ts`), leap days included.

@MainActor
@Suite("Journal rail", .serialized)
struct JournalRailTests {
    @Test func on_this_day_lists_other_years_with_an_entry_newest_first() async throws {
        let vault = try JournalTestVault()
        try vault.write("Lake swim.", on: "2097-06-15")
        try vault.write("First summer here.", on: "2095-06-15")
        try vault.write("A different day.", on: "2098-06-14")
        try vault.write("The shown day itself.", on: JournalTestVault.today)

        let entries = try #require(await vault.store.sameDayEntries(JournalTestVault.today))

        #expect(entries.map(\.date) == ["2097-06-15", "2095-06-15"])
        #expect(entries.first?.preview.contains("Lake swim.") == true)
    }

    @Test func on_this_day_reads_without_creating_days() async throws {
        let vault = try JournalTestVault()
        #expect(await vault.store.sameDayEntries(JournalTestVault.today) == [])
        #expect(try vault.journal.daysWithEntries(from: "1000-01-01", to: "2099-12-31").isEmpty)
    }

    @Test func a_leap_day_shows_on_feb_28_of_a_year_without_one_and_back() async throws {
        let vault = try JournalTestVault(today: "2099-03-01")
        try vault.write("Leap day entry.", on: "2096-02-29")
        try vault.write("Last day of February.", on: "2097-02-28")

        let onFeb28 = try #require(await vault.store.sameDayEntries("2099-02-28"))
        #expect(onFeb28.map(\.date) == ["2097-02-28", "2096-02-29"])

        let onLeapDay = try #require(await vault.store.sameDayEntries("2096-02-29"))
        #expect(onLeapDay.map(\.date) == ["2097-02-28"])
    }

    @Test func a_feb_28_in_a_leap_year_matches_only_feb_28() {
        #expect(JournalSameDay.matches("2096-02-28", "2097-02-28"))
        #expect(!JournalSameDay.matches("2096-02-28", "2092-02-29"))
        #expect(!JournalSameDay.matches("2097-06-15", "2097-06-15"), "the same year is not another year")
    }

    @Test func the_year_grid_has_four_columns_at_regular_width() {
        #expect(JournalYearScreen.columnCount(regularWidth: false, accessibilitySize: false) == 3)
        #expect(JournalYearScreen.columnCount(regularWidth: true, accessibilitySize: false) == 4)
        #expect(JournalYearScreen.columnCount(regularWidth: false, accessibilitySize: true) == 2)
        #expect(JournalYearScreen.columnCount(regularWidth: true, accessibilitySize: true) == 3)
    }
}
