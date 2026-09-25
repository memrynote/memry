import Foundation
import MemryCore
import Testing

@testable import Memry

// Spec 006 ST22 / ST43 / ST44: the synced-settings store over the real core,
// the device-local store, and the accent's contrast-safe inks.

@MainActor
@Suite("Settings", .serialized)
struct SettingsTests {
    private static func vault() throws -> (Vault, any SettingsProtocol) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let vault = try Vault.open(vaultId: "vault-settings", directory: directory.path)
        return (vault, try vault.settings(store: TaskTestKeychain()))
    }

    private static func payload(_ core: any SettingsProtocol) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(try core.snapshot().utf8)) as? [String: Any] ?? [:]
    }

    @Test func a_theme_write_keeps_fields_this_build_does_not_write() async throws {
        let (_, core) = try Self.vault()
        try core.set(path: "general.minimizeToTray", json: "true")
        try core.set(path: "experimental.agentSidebar", json: "true")
        let store = SettingsStore(core: core)
        await store.load()
        #expect(store.theme == .system)
        await store.setTheme(.dark)
        #expect(store.theme == .dark)
        let payload = try Self.payload(core)
        let general = payload["general"] as? [String: Any]
        #expect(general?["theme"] as? String == "dark")
        #expect(general?["minimizeToTray"] as? Bool == true)
        #expect((payload["experimental"] as? [String: Any])?["agentSidebar"] as? Bool == true)
    }

    @Test func an_unknown_theme_reads_as_system_and_is_left_alone() async throws {
        let (_, core) = try Self.vault()
        try core.set(path: "general.theme", json: "\"sepia\"")
        let store = SettingsStore(core: core)
        await store.load()
        #expect(store.theme == .system)
        #expect(store.themeRaw == "sepia")
    }

    @Test func another_devices_change_shows_after_a_refresh() async throws {
        let (vault, core) = try Self.vault()
        let store = SettingsStore(core: core)
        await store.load()
        let peer = try vault.settings(store: TaskTestKeychain())
        try peer.set(path: "general.accentColor", json: "\"#10b981\"")
        _ = try peer.setWeekdayTemplate(day: 5, templateId: "gratitude-journal")
        await store.refreshIfChanged()
        #expect(store.accentHex == "#10b981")
        #expect(store.journal.weekdayTemplates[5] == "gratitude-journal")
    }

    @Test func a_refused_write_puts_the_old_value_back_and_says_why() async throws {
        let store = SettingsStore(core: RefusingSettings())
        await store.load()
        await store.setFont(.serif)
        #expect(store.font == .system)
        #expect(store.failure != nil)
        await store.setReviewReminder(enabled: true, time: "07:30")
        #expect(store.review.enabled == false)
    }

    @Test func weekday_and_review_writes_round_trip() async throws {
        let (_, core) = try Self.vault()
        let store = SettingsStore(core: core)
        await store.load()
        await store.setWeekdayTemplate(day: 3, "tpl")
        await store.setWeekdayTemplate(day: 7, "ignored")
        await store.setReviewReminder(enabled: true, time: "06:45")
        #expect(store.journal.weekdayTemplates[3] == "tpl")
        #expect(store.review == ReviewReminderSettings(enabled: true, time: "06:45"))
        await store.setWeekdayTemplate(day: 3, nil)
        #expect(try core.get(path: "journal.weekdayTemplates.3") == "null")
    }

    @Test func json_strings_escape_quotes() {
        #expect(SettingsStore.jsonString("a\"b") == "\"a\\\"b\"")
        #expect(SettingsStore.jsonString("#f97316") == "\"#f97316\"")
    }

    @Test func the_last_feature_that_is_on_refuses_to_turn_off() throws {
        let defaults = try #require(UserDefaults(suiteName: "settings-\(UUID().uuidString)"))
        let local = LocalSettings(defaults: defaults)
        #expect(local.shippedOn == [.home, .journal, .tasks])
        #expect(local.set(.home, on: false))
        #expect(local.set(.journal, on: false))
        #expect(local.set(.tasks, on: false) == false)
        #expect(local.isOn(.tasks))
        #expect(LocalSettings(defaults: defaults).isOn(.home) == false)
    }

    @Test func the_accent_keeps_its_ink_readable_in_both_styles() {
        #expect(AccentColor.palette(for: "#f97316").ink.light == AdaptiveColor.RGB(hex: 0xB4_43_09))
        for preset in AccentColor.presets {
            let palette = AccentColor.palette(for: preset.hex)
            let onWhite = AdaptiveColor.RGB.contrast(palette.ink.light, AdaptiveColor.RGB(hex: 0xFF_FF_FF))
            let onDark = AdaptiveColor.RGB.contrast(palette.ink.dark, AdaptiveColor.RGB(hex: 0x12_12_12))
            #expect(onWhite >= 4.5, "\(preset.name) light ink")
            #expect(onDark >= 4.5, "\(preset.name) dark ink")
            let label = AdaptiveColor.RGB.contrast(palette.foreground.light, palette.fill.light)
            #expect(label >= 3, "\(preset.name) label on fill")
        }
        #expect(AccentColor.normalized("10B981") == "#10b981")
        #expect(AccentColor.normalized("#12") == nil)
    }

    @Test func the_review_time_reads_and_writes_hh_mm() {
        #expect(ReviewReminder.text(ReviewReminder.date("07:05")) == "07:05")
        #expect(ReviewReminder.text(ReviewReminder.date("23:59")) == "23:59")
    }
}

/// A core that refuses every write, for the revert path.
private final class RefusingSettings: SettingsProtocol, @unchecked Sendable {
    struct Refused: Error {}
    func clear(path _: String) throws { throw StorageError.Invalid(what: "refused") }
    func get(path _: String) throws -> String? { nil }
    func journalTemplates() throws -> JournalTemplateSettings {
        JournalTemplateSettings(defaultTemplate: nil, weekdayTemplates: Array(repeating: nil, count: 7))
    }
    func remove(path _: String) throws { throw StorageError.Invalid(what: "refused") }
    func reviewReminder() throws -> ReviewReminderSettings { ReviewReminderSettings(enabled: false, time: "18:00") }
    func revision() throws -> Int64 { 0 }
    func set(path _: String, json _: String) throws { throw StorageError.Invalid(what: "refused") }
    func setDefaultTemplate(templateId _: String?) throws -> JournalTemplateSettings { throw StorageError.Invalid(what: "refused") }
    func setReviewReminder(enabled _: Bool, time _: String) throws -> ReviewReminderSettings {
        throw StorageError.Invalid(what: "refused")
    }
    func setWeekdayTemplate(day _: UInt8, templateId _: String?) throws -> JournalTemplateSettings {
        throw StorageError.Invalid(what: "refused")
    }
    func snapshot() throws -> String { "{}" }
}
