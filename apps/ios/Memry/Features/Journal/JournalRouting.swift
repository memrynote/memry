import MemryCore
import Observation
import SwiftUI

// JP031, D11. The Journal tab is one `NavigationStack`: Year at the root,
// Month pushed on it, the Day page on top. Every surface that opens a day
// (a search hit, a journal backlink, a wiki link to a date, a related item,
// a reminder tap) goes through one route, ``JournalRouter/openDay(_:)``,
// which selects the tab and rebuilds the stack for that day.

/// A place inside the Journal tab. `Codable` so the path survives relaunch.
enum JournalRoute: Hashable, Codable, Sendable {
    /// A month, 1-12.
    case month(year: Int, month: Int)
    /// A day, `YYYY-MM-DD`.
    case day(String)
}

/// Navigation into and inside the Journal tab.
@MainActor
@Observable
final class JournalRouter {
    /// The stack above the Year root.
    var path: [JournalRoute] = []
    /// The year the root shows.
    var rootYear: Int
    /// The tab bar, so a route from another tab can switch here.
    @ObservationIgnored weak var tabs: TasksRouter?

    init(today: String = JournalDates.key(Date()), tabs: TasksRouter? = nil) {
        rootYear = JournalDates.yearMonth(today).year
        self.tabs = tabs
    }

    /// The day on top of the stack, if a day is shown.
    var shownDay: String? {
        if case let .day(date) = path.last { return date }
        return nil
    }

    /// Selects the Journal tab and shows `date` over its month and year.
    func openDay(_ date: String) {
        guard JournalDates.date(date) != nil else { return }
        tabs?.selectedTab = .journal
        let (year, month) = JournalDates.yearMonth(date)
        rootYear = year
        path = [.month(year: year, month: month), .day(date)]
    }

    /// Replaces the shown day in place (paging, ‹ ›, Today): the stack keeps
    /// its depth, so Back still leads to the month.
    func showDay(_ date: String) {
        guard JournalDates.date(date) != nil else { return }
        let (year, month) = JournalDates.yearMonth(date)
        rootYear = year
        path = [.month(year: year, month: month), .day(date)]
    }

    /// Shows a month over its year.
    func openMonth(year: Int, month: Int) {
        tabs?.selectedTab = .journal
        rootYear = year
        path = [.month(year: year, month: month)]
    }

    /// Shows a year (the stack's root).
    func openYear(_ year: Int) {
        tabs?.selectedTab = .journal
        rootYear = year
        path = []
    }

    /// Esc: one level up (Day → Month → Year), as desktop's breadcrumb does.
    func drillUp() {
        guard !path.isEmpty else { return }
        path.removeLast()
    }

    /// The saved form of the stack, for `SceneStorage`.
    var saved: String {
        let state = SavedState(rootYear: rootYear, path: path)
        guard let data = try? JSONEncoder().encode(state) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Restores a saved stack; `false` when there was none worth restoring.
    @discardableResult
    func restore(_ saved: String) -> Bool {
        guard !saved.isEmpty,
              let state = try? JSONDecoder().decode(SavedState.self, from: Data(saved.utf8)) else { return false }
        rootYear = state.rootYear
        path = state.path
        return true
    }

    private struct SavedState: Codable {
        let rootYear: Int
        let path: [JournalRoute]
    }
}

extension EnvironmentValues {
    /// Opens a day in the Journal tab from anywhere in the vault shell.
    @Entry var openJournalDay: (@MainActor (String) -> Void)?
}

extension ReminderTap {
    /// Where a tap goes: a task opens in the Tasks tab, a journal reminder
    /// opens its day in the Journal tab (D8), any other target selects Notes.
    @MainActor
    func open(in router: TasksRouter, journal: JournalRouter) {
        if targetType == "journal" {
            journal.openDay(targetId)
        } else {
            open(in: router)
        }
    }
}
