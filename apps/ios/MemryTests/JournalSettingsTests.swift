import Foundation
import MemryCore
import Testing

@testable import Memry

// JP048: Settings › Journal. Weekday rows follow the first day of the week but
// stay bound to the absolute weekday; each row names what an entry that day
// starts from; writes land in the core's synced settings (D9).

@MainActor
@Suite("Journal settings", .serialized)
struct JournalSettingsTests {
    private let templates = [
        TemplateSummary(id: "t-morning", name: "Morning pages", description: nil, icon: nil),
        TemplateSummary(id: "t-weekend", name: "Weekend review", description: nil, icon: nil)
    ]

    private func record(default id: String?, _ days: [Int: String] = [:]) -> JournalSettingsRecord {
        JournalSettingsRecord(defaultTemplate: id, weekdayTemplates: (0..<7).map { days[$0] })
    }

    @Test func weekdays_start_on_monday_or_sunday_and_keep_absolute_keys() {
        #expect(JournalSettingsRules.orderedWeekdays(weekStartsOn: 1) == [1, 2, 3, 4, 5, 6, 0])
        #expect(JournalSettingsRules.orderedWeekdays(weekStartsOn: 0) == [0, 1, 2, 3, 4, 5, 6])
        #expect(JournalSettingsRules.orderedWeekdays(weekStartsOn: 6) == [6, 0, 1, 2, 3, 4, 5])
    }

    @Test func a_row_names_its_template_the_inherited_default_or_a_deleted_one() {
        let settings = record(default: "t-morning", [6: "t-weekend", 0: "t-gone", 3: ""])
        let label = { (day: Int) in JournalSettingsRules.weekdayLabel(settings, weekday: day, templates: templates) }
        #expect(label(6) == .template("Weekend review"))
        #expect(label(1) == .inheritWith("Morning pages"))
        #expect(label(1).text == "Default · Morning pages")
        #expect(label(3) == .inheritWith("Morning pages"), "an empty id reads as unset")
        #expect(label(0) == .missing)
        #expect(label(0).text == "Deleted template")
        #expect(JournalSettingsRules.configuredCount(settings) == 2)
        #expect(JournalCopy.settingsWeekdayHeader(2) == "Per-Day Templates · 2 of 7 set")
    }

    @Test func an_unset_day_without_a_default_says_none() {
        let none = record(default: nil)
        #expect(JournalSettingsRules.weekdayLabel(none, weekday: 2, templates: templates) == .inheritNone)
        #expect(JournalSettingsRules.weekdayLabel(none, weekday: 2, templates: templates).text == "Default · none")
        #expect(JournalSettingsRules.defaultLabel(none, templates: templates) == "None")
        // Desktop's row: a missing default names nothing to inherit.
        let gone = record(default: "t-gone")
        #expect(JournalSettingsRules.weekdayLabel(gone, weekday: 2, templates: templates) == .inheritNone)
        #expect(JournalSettingsRules.defaultLabel(gone, templates: templates) == "Unknown template")
    }

    @Test func writes_persist_in_the_core_and_ask_for_a_sync() async throws {
        let vault = try JournalTestVault()
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }

        #expect(await vault.store.setDefaultTemplate("t-morning"))
        #expect(await vault.store.setWeekdayTemplate(6, templateId: "t-weekend"))
        #expect(await vault.store.setWeekdayTemplate(0, templateId: "t-weekend"))
        #expect(syncs == 3)

        let written = try vault.journal.settings()
        #expect(written.defaultTemplate == "t-morning")
        #expect(written.weekdayTemplates[6] == "t-weekend")
        #expect(written.weekdayTemplates[0] == "t-weekend")
        #expect(written.weekdayTemplates[1] == nil)
        #expect(vault.store.settings == written, "the store re-reads after a write")

        #expect(await vault.store.setWeekdayTemplate(0, templateId: nil))
        #expect(await vault.store.setDefaultTemplate(nil))
        let cleared = try vault.journal.settings()
        #expect(cleared.weekdayTemplates[0] == nil)
        #expect(cleared.weekdayTemplates[6] == "t-weekend", "clearing one day leaves the others")
        #expect(cleared.defaultTemplate == nil)
        #expect(try vault.journal.entryId(date: JournalTestVault.today) == nil, "settings create no day")
    }

    @Test func an_out_of_range_weekday_is_refused_without_a_write() async throws {
        let vault = try JournalTestVault()
        var syncs = 0
        vault.store.requestSync = { syncs += 1 }
        #expect(await vault.store.setWeekdayTemplate(7, templateId: "t-weekend") == false)
        #expect(await vault.store.setWeekdayTemplate(-1, templateId: "t-weekend") == false)
        #expect(syncs == 0)
    }

    @Test func the_stats_footer_key_is_per_vault() {
        #expect(JournalPreferences.statsFooterKey(vaultId: "a") != JournalPreferences.statsFooterKey(vaultId: "b"))
    }
}
