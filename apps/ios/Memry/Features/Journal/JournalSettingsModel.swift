import Foundation
import MemryCore

// JP048. The pure rules Settings › Journal draws with, after desktop's
// `pages/settings/journal-section.tsx`: the weekday rows in first-day-of-week
// order, each bound to its absolute weekday, and what each row says.

/// What a weekday row shows on its trailing side.
enum JournalWeekdayLabel: Equatable {
    /// The day's own template.
    case template(String)
    /// Unset: inherits the default template, named.
    case inheritWith(String)
    /// Unset, and there is no default template to inherit.
    case inheritNone
    /// Set to a template this vault no longer has.
    case missing

    var text: String {
        switch self {
        case let .template(name): name
        case let .inheritWith(name): JournalCopy.settingsWeekdayInheritWith(name)
        case .inheritNone: JournalCopy.settingsWeekdayInheritNone
        case .missing: JournalCopy.settingsWeekdayMissing
        }
    }

    /// The row inherits: drawn quieter than a day's own choice.
    var isInherited: Bool {
        switch self {
        case .inheritWith, .inheritNone: true
        case .template, .missing: false
        }
    }
}

enum JournalSettingsRules {
    /// Absolute weekdays (0 = Sunday) starting at `weekStartsOn`. Display
    /// order only: the stored key never moves when the week start changes.
    static func orderedWeekdays(weekStartsOn: Int) -> [Int] {
        let start = ((weekStartsOn % 7) + 7) % 7
        return (0..<7).map { (start + $0) % 7 }
    }

    /// The stored template of `weekday`, `nil` when unset. An empty id reads
    /// as unset, as desktop's `!stored` does.
    static func stored(_ settings: JournalSettingsRecord, weekday: Int) -> String? {
        guard settings.weekdayTemplates.indices.contains(weekday),
              let id = settings.weekdayTemplates[weekday], !id.isEmpty else { return nil }
        return id
    }

    /// How many of the seven weekdays have their own template.
    static func configuredCount(_ settings: JournalSettingsRecord) -> Int {
        (0..<7).filter { stored(settings, weekday: $0) != nil }.count
    }

    /// A template's name, `nil` when the id is unset or not in `templates`.
    static func name(of id: String?, in templates: [TemplateSummary]) -> String? {
        guard let id, !id.isEmpty else { return nil }
        return templates.first { $0.id == id }?.name
    }

    /// What `weekday`'s row says. A day inheriting a default that is itself
    /// missing reads "Default · none", as desktop's row does.
    static func weekdayLabel(
        _ settings: JournalSettingsRecord,
        weekday: Int,
        templates: [TemplateSummary]
    ) -> JournalWeekdayLabel {
        if let id = stored(settings, weekday: weekday) {
            return name(of: id, in: templates).map(JournalWeekdayLabel.template) ?? .missing
        }
        if let fallback = name(of: settings.defaultTemplate, in: templates) {
            return .inheritWith(fallback)
        }
        return .inheritNone
    }

    /// What the default template row says: the name, "None", or "Unknown
    /// template" for a default this vault no longer has.
    static func defaultLabel(_ settings: JournalSettingsRecord, templates: [TemplateSummary]) -> String {
        guard let id = settings.defaultTemplate, !id.isEmpty else { return JournalCopy.settingsTemplateNone }
        return name(of: id, in: templates) ?? JournalCopy.settingsUnknownTemplate
    }
}
