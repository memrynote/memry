import Foundation
import Observation

// Spec 006 ST22 / §5.2. The settings desktop keeps on each device, kept on
// this iPhone in `UserDefaults` and never in the sync payload.

enum ClockFormat: String, CaseIterable, Identifiable, Sendable {
    case system, h12 = "12h", h24 = "24h"
    var id: String { rawValue }
}

/// Desktop's `dateFormat` options, plus System.
enum DateFormatChoice: String, CaseIterable, Identifiable, Sendable {
    case system, us = "MM/DD/YYYY", eu = "DD/MM/YYYY", iso = "YYYY-MM-DD", dotted = "DD.MM.YYYY"
    var id: String { rawValue }
}

enum WeekStart: String, CaseIterable, Identifiable, Sendable {
    case sunday, monday
    var id: String { rawValue }
}

enum AttachmentDownload: String, CaseIterable, Identifiable, Sendable {
    case always, wifi, never
    var id: String { rawValue }
}

enum ImageFiling: String, CaseIterable, Identifiable, Sendable {
    case embed, link
    var id: String { rawValue }
}

/// A module that can be turned off (Features, 14).
enum AppFeature: String, CaseIterable, Identifiable, Sendable {
    case home, inbox, journal, tasks
    var id: String { rawValue }
}

/// F9: Journal (#2427) and Inbox (#2422) have shipped with their own tabs and
/// settings pages, so every module but Home has a Features toggle.
enum SettingsFeatureGates {
    /// Whether the feature has a tab on this phone, so its Features toggle
    /// does something. Home has no tab since the Inbox replaced it.
    static func isShipped(_ feature: AppFeature) -> Bool {
        switch feature {
        case .inbox, .tasks, .journal: true
        case .home: false
        }
    }
}

@MainActor
@Observable
final class LocalSettings {
    static let shared = LocalSettings()

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        clockFormat = ClockFormat(rawValue: defaults.string(forKey: Key.clock) ?? "") ?? .system
        dateFormat = DateFormatChoice(rawValue: defaults.string(forKey: Key.date) ?? "") ?? .system
        weekStart = WeekStart(rawValue: defaults.string(forKey: Key.week) ?? "")
            ?? (Calendar.current.firstWeekday == 1 ? .sunday : .monday)
        newNotesFolder = defaults.string(forKey: Key.folder)
        spellCheck = defaults.object(forKey: Key.spell) as? Bool ?? true
        usageMetrics = defaults.object(forKey: Key.metrics) as? Bool ?? false
        attachmentDownload = AttachmentDownload(rawValue: defaults.string(forKey: Key.download) ?? "") ?? .wifi
        imageFiling = ImageFiling(rawValue: defaults.string(forKey: Key.filing) ?? "") ?? .embed
        askEveryTime = defaults.object(forKey: Key.ask) as? Bool ?? true
        journalShowTasks = defaults.object(forKey: Key.journalTasks) as? Bool ?? true
        journalShowStats = defaults.object(forKey: Key.journalStats) as? Bool ?? false
        journalFolder = defaults.string(forKey: Key.journalFolder) ?? "journal"
        journalDateFormat = defaults.string(forKey: Key.journalDate) ?? "YYYY-MM-DD"
        perDayTemplates = defaults.object(forKey: Key.perDay) as? Bool ?? false
        var features: Set<AppFeature> = []
        for feature in AppFeature.allCases where defaults.object(forKey: Key.feature(feature)) as? Bool ?? true {
            features.insert(feature)
        }
        enabledFeatures = features
        lastSyncedAt = defaults.object(forKey: Key.lastSynced) as? Date
    }

    var clockFormat: ClockFormat { didSet { defaults.set(clockFormat.rawValue, forKey: Key.clock) } }
    var dateFormat: DateFormatChoice { didSet { defaults.set(dateFormat.rawValue, forKey: Key.date) } }
    var weekStart: WeekStart { didSet { defaults.set(weekStart.rawValue, forKey: Key.week) } }
    /// `nil` is the vault root.
    var newNotesFolder: String? { didSet { defaults.set(newNotesFolder, forKey: Key.folder) } }
    var spellCheck: Bool { didSet { defaults.set(spellCheck, forKey: Key.spell) } }
    var usageMetrics: Bool { didSet { defaults.set(usageMetrics, forKey: Key.metrics) } }
    var attachmentDownload: AttachmentDownload { didSet { defaults.set(attachmentDownload.rawValue, forKey: Key.download) } }
    var imageFiling: ImageFiling { didSet { defaults.set(imageFiling.rawValue, forKey: Key.filing) } }
    var askEveryTime: Bool { didSet { defaults.set(askEveryTime, forKey: Key.ask) } }
    var journalShowTasks: Bool { didSet { defaults.set(journalShowTasks, forKey: Key.journalTasks) } }
    var journalShowStats: Bool { didSet { defaults.set(journalShowStats, forKey: Key.journalStats) } }
    var journalFolder: String { didSet { defaults.set(journalFolder, forKey: Key.journalFolder) } }
    var journalDateFormat: String { didSet { defaults.set(journalDateFormat, forKey: Key.journalDate) } }
    /// The journal page's "Different template per day" switch.
    var perDayTemplates: Bool { didSet { defaults.set(perDayTemplates, forKey: Key.perDay) } }
    private(set) var enabledFeatures: Set<AppFeature>
    /// The last sync pass that finished on this iPhone (spec 006 ST15).
    var lastSyncedAt: Date? { didSet { defaults.set(lastSyncedAt, forKey: Key.lastSynced) } }

    func isOn(_ feature: AppFeature) -> Bool { enabledFeatures.contains(feature) }

    /// The shipped features that are on. The last one refuses to turn off.
    var shippedOn: [AppFeature] {
        AppFeature.allCases.filter { SettingsFeatureGates.isShipped($0) && isOn($0) }
    }

    /// - Returns: `false` when the change was refused (the last feature on).
    @discardableResult
    func set(_ feature: AppFeature, on: Bool) -> Bool {
        if !on, shippedOn == [feature] { return false }
        if on { enabledFeatures.insert(feature) } else { enabledFeatures.remove(feature) }
        defaults.set(on, forKey: Key.feature(feature))
        return true
    }

    private enum Key {
        static let clock = "settings.clockFormat"
        static let date = "settings.dateFormat"
        static let week = "settings.weekStart"
        static let folder = "settings.newNotesFolder"
        static let spell = "settings.spellCheck"
        static let metrics = "settings.usageMetrics"
        static let download = "settings.attachmentDownload"
        static let filing = "settings.inbox.imageFiling"
        static let ask = "settings.inbox.askEveryTime"
        static let journalTasks = "settings.journal.showTasks"
        static let journalStats = "settings.journal.showStatsFooter"
        static let journalFolder = "settings.journal.folder"
        static let journalDate = "settings.journal.dateFormat"
        static let perDay = "settings.journal.perDay"
        static let lastSynced = "settings.lastSyncedAt"
        static func feature(_ feature: AppFeature) -> String { "settings.features.\(feature.rawValue)" }
    }
}
