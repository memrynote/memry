import Foundation
import MemryCore
import Testing

@testable import Memry

// JP030: the journal store over a scratch vault and the real `Journal`
// surface. The rules are the core's and pinned by vectors; these check what
// the store adds: reads never write (D2), writes re-read and ask for a sync,
// today comes from the clock (D3), and the debug pin.

/// A scratch vault with the real journal surface and a store over it.
@MainActor
struct JournalTestVault {
    let vault: Vault
    let journal: Journal
    let store: JournalStore
    let directory: URL

    nonisolated static let today = "2099-06-15"

    init(today: String = JournalTestVault.today) throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-journal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        vault = try Vault.open(vaultId: "vault-journal-test", directory: directory.path)
        journal = try vault.journal(store: TaskTestKeychain())
        store = JournalStore(
            core: journal,
            clock: JournalClock(pinned: today),
            vaultId: "vault-journal-test",
            executor: CoreExecutor()
        )
    }

    /// Writes one paragraph into `date` through the core.
    func write(_ text: String, on date: String) throws {
        _ = try journal.editDay(
            date: date,
            edit: .insertParagraph(afterBlockId: nil, text: text, newBlockId: UUID().uuidString.lowercased())
        )
    }
}

@MainActor
@Suite("Journal store", .serialized)
struct JournalStoreTests {
    @Test func reading_days_months_and_years_creates_nothing() async throws {
        let vault = try JournalTestVault()
        #expect(await vault.store.loadDay(JournalTestVault.today) == nil)
        #expect(vault.store.hasRead(JournalTestVault.today))
        let month = try #require(await vault.store.loadMonth(year: 2099, month: 6))
        #expect(month.days.count == 30)
        #expect(month.days.first?.date == "2099-06-30", "newest first")
        #expect(month.entryCount == 0)
        _ = await vault.store.loadYear(2099)
        await vault.store.loadStreak()
        #expect(vault.store.streak?.current == 0)
        #expect(try vault.journal.entryId(date: JournalTestVault.today) == nil)
    }

    @Test func a_write_through_the_store_creates_the_day_rereads_and_asks_for_a_sync() async throws {
        let vault = try JournalTestVault()
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }
        _ = await vault.store.loadMonth(year: 2099, month: 6)
        let before = vault.store.generation

        let result = await vault.store.perform(date: JournalTestVault.today) { core in
            try core.editDay(
                date: JournalTestVault.today,
                edit: .insertParagraph(afterBlockId: nil, text: "Walked to the lake.", newBlockId: "b1")
            )
        }

        #expect(result?.created == true)
        #expect(syncs == 1)
        #expect(vault.store.generation > before)
        let day = try #require(vault.store.cachedDay(JournalTestVault.today))
        #expect(day.id == "j2099-06-15")
        #expect(day.wordCount == 4)
        let month = try #require(vault.store.month(year: 2099, month: 6))
        #expect(month.entryCount == 1)
        #expect(month.days.first { $0.date == JournalTestVault.today }?.isToday == true)
    }

    @Test func the_streak_counts_from_the_clocks_today() async throws {
        let vault = try JournalTestVault()
        try vault.write("one", on: "2099-06-13")
        try vault.write("two", on: "2099-06-14")
        await vault.store.loadStreak()
        #expect(vault.store.streak?.current == 2, "today empty, yesterday counts")
        #expect(vault.store.streak?.longest == 2)
    }

    @Test func a_failed_write_is_reported_and_asks_for_no_sync() async throws {
        let vault = try JournalTestVault()
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }
        let result = await vault.store.perform(date: "2099-02-30") { core in
            try core.setTags(date: "2099-02-30", tags: ["x"])
        }
        #expect(result == nil)
        #expect(syncs == 0)
        #expect(vault.store.failure != nil)
    }

    @Test func refresh_rereads_what_was_shown_after_a_write_made_elsewhere() async throws {
        let vault = try JournalTestVault()
        await vault.store.loadDay(JournalTestVault.today)
        try vault.write("from another screen", on: JournalTestVault.today)
        #expect(vault.store.cachedDay(JournalTestVault.today) == nil)
        await vault.store.refresh()
        #expect(vault.store.cachedDay(JournalTestVault.today) != nil)
    }
}

@MainActor
@Suite("Journal clock")
struct JournalClockTests {
    @Test func the_pin_wins_and_ignores_the_instant() {
        let clock = JournalClock(now: { Date(timeIntervalSince1970: 0) }, pinned: "2099-06-15")
        #expect(clock.today == "2099-06-15")
        clock.refresh()
        #expect(clock.today == "2099-06-15")
    }

    @Test func without_a_pin_today_is_the_local_calendar_date() {
        let noon = JournalDates.date("2099-06-15")?.addingTimeInterval(12 * 3600) ?? Date()
        let clock = JournalClock(now: { noon }, pinned: nil)
        #expect(clock.today == "2099-06-15")
    }

    @Test func the_debug_pin_reads_the_environment_and_rejects_non_days() {
        let defaults = UserDefaults(suiteName: "journal-clock-\(UUID().uuidString)") ?? .standard
        #expect(JournalClock.debugPin(environment: ["MEMRY_JOURNAL_TODAY": "2099-06-15"], defaults: defaults) == "2099-06-15")
        #expect(JournalClock.debugPin(environment: ["MEMRY_JOURNAL_TODAY": "2099-02-30"], defaults: defaults) == nil)
        #expect(JournalClock.debugPin(environment: [:], defaults: defaults) == nil)
        defaults.set("2099-01-02", forKey: "MEMRY_JOURNAL_TODAY")
        #expect(JournalClock.debugPin(environment: [:], defaults: defaults) == "2099-01-02")
    }

    @Test func calendar_arithmetic_stays_on_calendar_days() {
        #expect(JournalDates.adding(1, to: "2099-12-31") == "2100-01-01")
        #expect(JournalDates.adding(-1, to: "2096-03-01") == "2096-02-29")
        #expect(JournalDates.days(from: "2099-06-15", to: "2099-06-18") == 3)
        #expect(JournalDates.date("2099-02-29") == nil)
        #expect(JournalDates.yearMonth("2099-06-15") == (2099, 6))
    }
}
