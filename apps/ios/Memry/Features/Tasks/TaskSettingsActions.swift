import MemryCore
import SwiftUI

// TP055. Settings > Tasks reads and writes, and the page's opening view.
//
// Every value comes from the core (`Tasks.taskSettings`, TP023), which
// coerces a missing or invalid stored value to desktop's default and refuses
// to write one desktop's schema would reject. The option lists below are
// desktop's menus (`pages/settings/tasks-section.tsx`), not validation.

/// Desktop's `SORT_OPTIONS`, in its order.
enum TaskSettingsSortOrder: String, CaseIterable, Identifiable, Sendable {
    case manual, dueDate, priority, createdAt

    var id: String { rawValue }
}

/// Desktop's `DEFAULT_VIEW_OPTIONS`, in its order (the toolbar scope order).
enum TaskSettingsDefaultView: String, CaseIterable, Identifiable, Sendable {
    case all, today, tomorrow, next7

    var id: String { rawValue }

    var tab: TasksTab {
        switch self {
        case .all: .all
        case .today: .today
        case .tomorrow: .tomorrow
        case .next7: .next7
        }
    }
}

/// `staleInboxDays` bounds of desktop's schema (`min(1).max(90)`).
enum TaskSettingsLimits {
    static let staleInboxDays: ClosedRange<Int> = 1 ... 90
}

extension TasksStore {
    /// Re-reads the task settings (another device may have changed the synced
    /// ones since `load`).
    func loadTaskSettings() async {
        if let loaded = await read({ try $0.taskSettings() }) {
            settingsChanged(loaded)
        }
    }

    /// `nil` clears the default: new tasks fall back to the inbox project.
    func setDefaultProject(_ projectId: String?) async {
        await writeTaskSettings { try $0.setDefaultProject(projectId: projectId) }
    }

    func setDefaultSortOrder(_ order: TaskSettingsSortOrder) async {
        let value = order.rawValue
        await writeTaskSettings { try $0.setDefaultSortOrder(order: value) }
    }

    /// Local to this device, as on desktop.
    func setDefaultView(_ view: TaskSettingsDefaultView) async {
        let value = view.rawValue
        await writeTaskSettings { try $0.setDefaultView(view: value) }
    }

    func setStaleInboxDays(_ days: Int) async {
        let value = Int64(days)
        await writeTaskSettings { try $0.setStaleInboxDays(days: value) }
    }

    private func writeTaskSettings(
        _ work: @escaping @Sendable (any TasksProtocol) throws -> TaskSettingsItem
    ) async {
        if let updated = await run(work) {
            settingsChanged(updated)
        }
    }

    // MARK: Opening view

    private static let openingViewKey = "taskSettings.openingViewApplied"

    /// Opens the page on `defaultView` when it has no view state of its own,
    /// once per store. Desktop `pages/tasks.tsx:211`: stored tab, else the
    /// preference, else `all`. The list calls this after the store loads.
    ///
    /// "No view state" is read as the page state still being the untouched
    /// default: the store does not say whether it restored a saved one.
    func openOnDefaultView() async {
        guard scratch[Self.openingViewKey] == nil else { return }
        scratch[Self.openingViewKey] = "applied"
        guard state == TasksViewState() else { return }
        if settings == nil { await loadTaskSettings() }
        guard let tab = Self.openingTab(for: state, defaultView: settings?.defaultView) else { return }
        await update { $0.tab = tab }
    }

    /// The tab a page in `state` should switch to for `defaultView`, or `nil`
    /// to stay. A value this build does not know stays on the current tab,
    /// as desktop's `parseInternalTab` does.
    static func openingTab(for state: TasksViewState, defaultView: String?) -> TasksTab? {
        guard state == TasksViewState(),
              let view = defaultView.flatMap(TaskSettingsDefaultView.init(rawValue:)),
              view.tab != state.tab
        else { return nil }
        return view.tab
    }
}
