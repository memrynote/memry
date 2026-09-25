import Foundation
import MemryCore
import Testing
@testable import Memry

// JP047 (export title) and JP049 (template seeding). The Journal API has no
// template create and templates only arrive through a sync pull, so the
// seeded and already-existing paths run over `ScriptedSeedJournal`: the real
// core of a `JournalTestVault` with `templateFor` and `seedFromTemplate`
// scripted. The missing-template path also runs against the real core.

/// The real `Journal` with the template answers scripted.
final class ScriptedSeedJournal: JournalProtocol, @unchecked Sendable {
    let base: Journal
    var templateId: String?
    var answer: (String) throws -> SeedOutcome = { _ in throw StorageError.NotFound(what: "template") }
    private(set) var seedCalls = 0
    private(set) var lastStrings: JournalTemplateStrings?

    init(base: Journal) { self.base = base }

    func templateFor(date: String) throws -> String? { templateId }

    func seedFromTemplate(date: String, templateId: String, strings: JournalTemplateStrings) throws -> SeedOutcome {
        seedCalls += 1
        lastStrings = strings
        return try answer(date)
    }

    func clearProperty(date: String, name: String) throws { try base.clearProperty(date: date, name: name) }
    func day(date: String) throws -> JournalDayRecord? { try base.day(date: date) }
    func daysWithEntries(from: String, to: String) throws -> [String] { try base.daysWithEntries(from: from, to: to) }
    func deleteReminder(id: String) throws { try base.deleteReminder(id: id) }
    func dismissReminder(id: String) throws { try base.dismissReminder(id: id) }
    func editDay(date: String, edit: BlockEdit) throws -> JournalEditResult { try base.editDay(date: date, edit: edit) }
    func entryId(date: String) throws -> String? { try base.entryId(date: date) }
    func heatmap(year: Int64) throws -> [JournalHeatmapEntry] { try base.heatmap(year: year) }
    func month(year: Int64, month: UInt32, today: String) throws -> JournalMonthRecord {
        try base.month(year: year, month: month, today: today)
    }
    func reminders(date: String) throws -> [JournalReminder] { try base.reminders(date: date) }
    func removeProperty(date: String, name: String) throws { try base.removeProperty(date: date, name: name) }
    func renameProperty(date: String, from: String, to: String) throws {
        try base.renameProperty(date: date, from: from, to: to)
    }
    func resolveWikiTarget(target: String) throws -> WikiTargetMatch? { try base.resolveWikiTarget(target: target) }
    func setDefaultTemplate(templateId: String?) throws -> JournalSettingsRecord {
        try base.setDefaultTemplate(templateId: templateId)
    }
    func setProperty(date: String, name: String, valueJson: String) throws {
        try base.setProperty(date: date, name: name, valueJson: valueJson)
    }
    func setReminder(date: String, remindAt: String, note: String?) throws -> String {
        try base.setReminder(date: date, remindAt: remindAt, note: note)
    }
    func setTags(date: String, tags: [String]) throws -> [String] { try base.setTags(date: date, tags: tags) }
    func setWeekdayTemplate(weekday: UInt8, templateId: String?) throws -> JournalSettingsRecord {
        try base.setWeekdayTemplate(weekday: weekday, templateId: templateId)
    }
    func settings() throws -> JournalSettingsRecord { try base.settings() }
    func snoozeReminder(id: String, until: String) throws { try base.snoozeReminder(id: id, until: until) }
    func streak(today: String) throws -> JournalStreakRecord { try base.streak(today: today) }
    func updateReminder(id: String, remindAt: String, note: String?) throws {
        try base.updateReminder(id: id, remindAt: remindAt, note: note)
    }
    func year(year: Int64, today: String) throws -> JournalYearRecord { try base.year(year: year, today: today) }
}

@MainActor
@Suite("Journal seeding", .serialized)
struct JournalSeedTests {
    private static let today = JournalTestVault.today

    /// A store over the scripted core. The vault is kept so its database
    /// stays open for the test's length.
    private struct Scripted {
        let vault: JournalTestVault
        let core: ScriptedSeedJournal
        let store: JournalStore
    }

    private func makeScripted() throws -> Scripted {
        let vault = try JournalTestVault()
        let core = ScriptedSeedJournal(base: vault.journal)
        let store = JournalStore(
            core: core,
            clock: JournalClock(pinned: Self.today),
            vaultId: "vault-journal-test",
            executor: CoreExecutor()
        )
        return Scripted(vault: vault, core: core, store: store)
    }

    // MARK: Strings (D4)

    @Test func the_strings_match_desktops_intl_en_us_output() throws {
        let components = DateComponents(year: 2099, month: 6, day: 15, hour: 9, minute: 5)
        let now = try #require(JournalDates.calendar.date(from: components))
        let strings = try #require(
            JournalSeedStrings.make(date: Self.today, now: now, locale: Locale(identifier: "en_US"))
        )
        #expect(strings.longDate == "Monday, June 15, 2099")
        // ICU (and V8's Intl) put a narrow no-break space before the period.
        #expect(strings.time.replacingOccurrences(of: "\u{202F}", with: " ") == "9:05 AM")
        #expect(strings.dayOfWeek == "Monday")
    }

    @Test func a_malformed_date_formats_nothing() {
        #expect(JournalSeedStrings.make(date: "2099-02-30", now: Date()) == nil)
    }

    // MARK: Seeding (D2, D10)

    @Test func a_day_without_a_template_is_not_seeded_or_created() async throws {
        let vault = try JournalTestVault()
        #expect(await vault.store.seedIfNeeded(Self.today) == false)
        #expect(try vault.journal.entryId(date: Self.today) == nil)
        #expect(vault.store.failure == nil)
    }

    @Test func a_template_not_here_yet_shows_no_error_and_creates_nothing() async throws {
        let vault = try JournalTestVault()
        _ = try vault.journal.setDefaultTemplate(templateId: "tpl-not-synced")
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }

        #expect(await vault.store.seedIfNeeded(Self.today) == false)
        #expect(vault.store.failure == nil)
        #expect(syncs == 0, "a miss writes nothing, so it asks for no sync")
        #expect(try vault.journal.entryId(date: Self.today) == nil)
    }

    @Test func a_miss_retries_only_after_the_generation_moves() async throws {
        let scripted = try makeScripted()
        let (core, store) = (scripted.core, scripted.store)
        core.templateId = "tpl-morning"

        #expect(await store.seedIfNeeded(Self.today) == false)
        #expect(await store.seedIfNeeded(Self.today) == false)
        #expect(core.seedCalls == 1, "the same generation does not retry")

        await store.refresh()
        #expect(await store.seedIfNeeded(Self.today) == false)
        #expect(core.seedCalls == 2, "a sync pass (refresh) retries once")
        #expect(store.failure == nil)
    }

    @Test func a_seed_creates_the_day_once_and_syncs() async throws {
        let scripted = try makeScripted()
        let (core, store) = (scripted.core, scripted.store)
        core.templateId = "tpl-morning"
        core.answer = { date in
            let result = try core.base.editDay(
                date: date,
                edit: .insertParagraph(afterBlockId: nil, text: "Morning pages", newBlockId: "seed-1")
            )
            return .seeded(id: result.id)
        }
        var syncs = 0
        store.requestSync = { syncs += 1 }
        let before = store.generation

        #expect(await store.seedIfNeeded(Self.today) == true)
        #expect(store.cachedDay(Self.today) != nil)
        #expect(store.generation > before)
        #expect(syncs == 1)
        #expect(core.lastStrings?.dayOfWeek.isEmpty == false)

        #expect(await store.seedIfNeeded(Self.today) == false)
        #expect(core.seedCalls == 1, "a day with an entry is never seeded again")
    }

    @Test func a_day_seeded_on_another_device_is_never_seeded_twice() async throws {
        let scripted = try makeScripted()
        let (core, store) = (scripted.core, scripted.store)
        core.templateId = "tpl-morning"
        core.answer = { _ in .alreadyExists(id: "j2099-06-15") }

        #expect(await store.seedIfNeeded(Self.today) == false)
        await store.refresh()
        #expect(await store.seedIfNeeded(Self.today) == false)
        #expect(core.seedCalls == 1)
    }

    @Test func the_attempt_state_round_trips_through_scratch() {
        for attempt in [JournalSeedAttempt.inFlight, .done, .missed(generation: 7)] {
            #expect(JournalSeedAttempt(scratch: attempt.scratchValue) == attempt)
        }
        #expect(JournalSeedAttempt(scratch: nil) == nil)
        #expect(JournalSeedAttempt.mayAttempt(.missed(generation: 3), generation: 4))
        #expect(!JournalSeedAttempt.mayAttempt(.missed(generation: 4), generation: 4))
        #expect(!JournalSeedAttempt.mayAttempt(.inFlight, generation: 4))
    }

    // MARK: Export (JP047)

    @Test func the_export_uses_desktops_note_title() {
        let export = JournalMoreMenu.noteExport(date: "2099-06-15", text: "Walked to the lake.")
        #expect(export.title == "Journal - June 15, 2099")
        #expect(export.filename == "Journal - June 15, 2099.txt")
        #expect(export.contents == "Journal - June 15, 2099\n\nWalked to the lake.")
    }
}
