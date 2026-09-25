import Foundation
import MemryCore
import Observation

// Spec 006 ST22. The synced settings (F2) over the core's `Settings` object,
// plus the device-local ones in `LocalSettings`.
//
// **Optimistic, then true.** A control writes its new value at once; the core
// call follows on the executor. A refusal puts the old value back and sets
// `failure` (mapped through `ErrorMapping`). After a sync pass the shell calls
// `refreshIfChanged()`, which compares the core's `revision()` and re-reads,
// so an open screen shows another device's change without a relaunch.

/// The synced fields iOS writes, as the payload spells them.
enum SyncedPath {
    static let theme = "general.theme"
    static let accent = "general.accentColor"
    static let font = "general.fontFamily"
    static let language = "general.language"
}

/// Desktop's four theme values. An unknown synced value reads as `.system`
/// and is left in the payload untouched (F6).
enum ThemeChoice: String, CaseIterable, Identifiable, Sendable {
    case system, light, white, dark
    var id: String { rawValue }
}

/// Desktop's built-in font families (`appearance-section.tsx`).
enum FontChoice: String, CaseIterable, Identifiable, Sendable {
    case system, sansSerif = "sans-serif", serif, gelasio, geist, inter, monospace
    var id: String { rawValue }
}

@MainActor
@Observable
final class SettingsStore {
    private let core: any SettingsProtocol
    private let executor: CoreExecutor
    /// Asks the vault for a sync pass after a synced write.
    var requestSync: (@MainActor () -> Void)?

    private(set) var themeRaw: String?
    private(set) var accentRaw: String?
    private(set) var fontRaw: String?
    private(set) var languageRaw: String?
    private(set) var journal = JournalTemplateSettings(defaultTemplate: nil, weekdayTemplates: Array(repeating: nil, count: 7))
    private(set) var review = ReviewReminderSettings(enabled: false, time: "18:00")
    private(set) var failure: UserFacingError?
    private(set) var isLoaded = false
    private var revision: Int64 = -1

    init(core: any SettingsProtocol, executor: CoreExecutor = .shared) {
        self.core = core
        self.executor = executor
    }

    // MARK: Typed reads

    var theme: ThemeChoice { themeRaw.flatMap(ThemeChoice.init(rawValue:)) ?? .system }
    var accentHex: String { accentRaw.flatMap(AccentColor.normalized) ?? AccentColor.defaultHex }
    var font: FontChoice { fontRaw.flatMap(FontChoice.init(rawValue:)) ?? .system }
    var language: String { languageRaw ?? "en" }

    // MARK: Loading

    func load() async {
        let core = core
        do {
            let (snapshot, journal, review, revision) = try await executor.run {
                (try core.snapshot(), try core.journalTemplates(), try core.reviewReminder(), try core.revision())
            }
            apply(snapshot: snapshot)
            // F5: an inbound language takes the same path as a local pick;
            // none synced means the app follows the system language.
            LanguageOverride.apply(languageRaw)
            self.journal = journal
            let reviewChanged = self.review != review
            self.review = review
            self.revision = revision
            isLoaded = true
            // An inbound synced change reschedules this device's reminder.
            if reviewChanged { await ReviewReminder.reschedule(review) }
        } catch {
            report(error)
        }
        AppearanceState.shared.update(from: self)
    }

    /// Re-reads when another device's change landed (or a local write moved
    /// the revision). Cheap: one row read when nothing changed.
    func refreshIfChanged() async {
        let core = core
        guard let current = try? await executor.run({ try core.revision() }), current != revision else { return }
        await load()
    }

    private func apply(snapshot json: String) {
        let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
        let general = object["general"] as? [String: Any]
        themeRaw = general?["theme"] as? String
        accentRaw = general?["accentColor"] as? String
        fontRaw = general?["fontFamily"] as? String
        languageRaw = general?["language"] as? String
    }

    // MARK: Writes

    func setTheme(_ choice: ThemeChoice) async {
        await write(path: SyncedPath.theme, value: choice.rawValue, get: \.themeRaw, set: { $0.themeRaw = $1 })
    }

    func setAccent(_ hex: String) async {
        guard let hex = AccentColor.normalized(hex) else { return }
        await write(path: SyncedPath.accent, value: hex, get: \.accentRaw, set: { $0.accentRaw = $1 })
    }

    func setFont(_ choice: FontChoice) async {
        await write(path: SyncedPath.font, value: choice.rawValue, get: \.fontRaw, set: { $0.fontRaw = $1 })
    }

    /// F5: written to the payload and applied to this app on its next launch.
    func setLanguage(_ code: String) async {
        await write(path: SyncedPath.language, value: code, get: \.languageRaw, set: { $0.languageRaw = $1 })
        if failure == nil { LanguageOverride.apply(code) }
    }

    private func write(
        path: String,
        value: String,
        get: KeyPath<SettingsStore, String?>,
        set: (SettingsStore, String?) -> Void
    ) async {
        let previous = self[keyPath: get]
        guard previous != value else { return }
        set(self, value)
        failure = nil
        AppearanceState.shared.update(from: self)
        let core = core
        let json = Self.jsonString(value)
        do {
            try await executor.run { try core.set(path: path, json: json) }
            revision = (try? await executor.run { try core.revision() }) ?? revision
            requestSync?()
        } catch {
            set(self, previous)
            AppearanceState.shared.update(from: self)
            report(error)
        }
    }

    func setDefaultTemplate(_ id: String?) async {
        let previous = journal
        journal = JournalTemplateSettings(defaultTemplate: id, weekdayTemplates: journal.weekdayTemplates)
        await journalWrite(previous) { try $0.setDefaultTemplate(templateId: id) }
    }

    func setWeekdayTemplate(day: Int, _ id: String?) async {
        guard (0 ... 6).contains(day) else { return }
        let previous = journal
        var days = journal.weekdayTemplates
        days[day] = id
        journal = JournalTemplateSettings(defaultTemplate: journal.defaultTemplate, weekdayTemplates: days)
        let weekday = UInt8(day)
        await journalWrite(previous) { try $0.setWeekdayTemplate(day: weekday, templateId: id) }
    }

    private func journalWrite(
        _ previous: JournalTemplateSettings,
        _ work: @escaping @Sendable (any SettingsProtocol) throws -> JournalTemplateSettings
    ) async {
        let core = core
        do {
            journal = try await executor.run { try work(core) }
            requestSync?()
        } catch {
            journal = previous
            report(error)
        }
    }

    func setReviewReminder(enabled: Bool, time: String) async {
        let previous = review
        review = ReviewReminderSettings(enabled: enabled, time: time)
        let core = core
        do {
            review = try await executor.run { try core.setReviewReminder(enabled: enabled, time: time) }
            requestSync?()
        } catch {
            review = previous
            report(error)
        }
    }

    func clearFailure() { failure = nil }

    private func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a settings operation failed", .code(mapped.code))
        failure = mapped
    }

    /// A JSON string literal for one value.
    static func jsonString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes])) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}

/// F5. The app's language override, read by iOS at the next launch.
enum LanguageOverride {
    static let key = "AppleLanguages"

    static func apply(_ code: String?, defaults: UserDefaults = .standard) {
        if let code { defaults.set([code], forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}
