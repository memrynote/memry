import Foundation
import MemryCore
import SwiftUI
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

    @Test func on_this_day_lists_later_years_too() async throws {
        let vault = try JournalTestVault()
        try vault.write("Planned ahead.", on: "2101-06-15")
        try vault.write("Last year.", on: "2098-06-15")

        let entries = try #require(await vault.store.sameDayEntries("2097-06-15"))

        #expect(entries.map(\.date) == ["2101-06-15", "2098-06-15"])
    }

    @Test func an_other_year_entry_dated_today_reads_today() {
        let today = JournalTestVault.today
        #expect(JournalCopy.Rail.sameDayDistance("2099-06-15", shown: "2097-06-15", today: today) == "Today")
        #expect(JournalCopy.Rail.sameDayDistance("2098-06-15", shown: "2097-06-15", today: today) == "1 year later")
        #expect(JournalCopy.Rail.sameDayDistance("2095-06-15", shown: "2097-06-15", today: today) == "2 years ago")
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

    @Test func a_leap_year_feb_28_keeps_to_feb_28_and_years_before_1000_count() async throws {
        let vault = try JournalTestVault(today: "2099-03-01")
        try vault.write("Leap day entry.", on: "2092-02-29")
        try vault.write("Same day, long ago.", on: "0999-02-28")

        let entries = try #require(await vault.store.sameDayEntries("2096-02-28"))
        #expect(entries.map(\.date) == ["0999-02-28"])
    }

    @Test func the_year_grid_has_four_columns_only_at_regular_width_and_height() {
        func columns(_ horizontal: UserInterfaceSizeClass, _ vertical: UserInterfaceSizeClass, large: Bool = false) -> Int {
            JournalYearScreen.columnCount(horizontal: horizontal, vertical: vertical, accessibilitySize: large)
        }
        #expect(columns(.compact, .regular) == 3, "iPhone portrait, iPad Split View")
        #expect(columns(.regular, .compact) == 3, "large iPhone in landscape")
        #expect(columns(.regular, .regular) == 4, "iPad")
        #expect(columns(.compact, .regular, large: true) == 2)
        #expect(columns(.regular, .compact, large: true) == 2)
        #expect(columns(.regular, .regular, large: true) == 3)
    }
}
