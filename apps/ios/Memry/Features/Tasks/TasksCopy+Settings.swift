import Foundation

// TP055. Settings > Tasks copy, mirroring desktop's
// `packages/i18n/src/locales/en/settings.json` `tasks.*`.

extension TasksCopy {
    // MARK: Screen (`tasks.header.*`, `tasks.groups.*`)

    static let settingsTitle = "Task Settings"
    static let settingsLoading = "Loading settings…"
    static let settingsDefaultsGroup = "Defaults"
    static let settingsInboxGroup = "Inbox"

    /// Desktop writes its task settings to its local table only (§6 TP023),
    /// so nothing set here reaches a computer and the other way round.
    static let settingsDeviceFootnote =
        "Desktop keeps its task settings on each computer, so changes here do not appear there. "
        + "Default View applies to this device only."

    // MARK: Default project (`tasks.defaultProject.*`)

    static let settingsDefaultProject = "Default Project"
    static let settingsDefaultProjectHelp = "Assigned when no project is selected"
    static let settingsMissingProject = "Project not found"

    /// The "no default" choice, naming the project new tasks fall back to.
    /// Desktop says "No default (use Personal)"; here the vault's own inbox
    /// project is named.
    static func settingsNoDefaultProject(inbox: String?) -> String {
        guard let inbox, !inbox.isEmpty else { return "No default" }
        return "No default (use \(inbox))"
    }

    static func settingsArchivedProject(_ name: String) -> String { "\(name) (archived)" }

    // MARK: Default sort (`tasks.sortOrder.*`)

    static let settingsSortOrder = "Default Sort Order"
    static let settingsSortOrderHelp = "How tasks are ordered in list view"

    static func settingsSortOrderLabel(_ order: TaskSettingsSortOrder) -> String {
        switch order {
        case .manual: "Manual (drag & drop)"
        case .dueDate: "Due Date"
        case .priority: "Priority"
        case .createdAt: "Date Created"
        }
    }

    // MARK: Default view (`tasks.defaultView.*`)

    static let settingsDefaultView = "Default View"
    static let settingsDefaultViewHelp = "Which scope the Tasks page opens on"

    // MARK: Stale inbox (`tasks.staleInbox.*`)

    static let settingsStaleInbox = "Stale Inbox Threshold"
    static let settingsStaleInboxHelp = "Tasks older than this are highlighted as stale"

    static func settingsStaleInboxValue(_ days: Int) -> String {
        days == 1 ? "1 day" : "\(days) days"
    }
}
