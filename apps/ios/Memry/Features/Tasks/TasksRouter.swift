import Observation
import SwiftUI

// TP031. Where the Tasks tab is, and the vault shell's page selection.
//
// **Opening a task by id** (search results, a task block in a note, a reminder
// notification) goes through ``TasksRouter``: it selects the Tasks tab and
// shows that task's detail. A task that no longer exists opens a sensible
// "not in this vault" state inside the detail rather than crashing or showing
// a ghost (FR-061).
//
// **One path, two layouts (#4350).** `path` is the Tasks tab's whole place,
// written as the phone stack: the list's pages, then a task, then what was
// opened from inside it. At regular width the same path splits at its first
// task: the routes before it are the list column's stack, the task is the
// detail column, and the routes after it are the detail column's stack. A
// change of width converts nothing, and `LaunchSnapshot` saves one shape.

/// A place inside the Tasks tab.
enum TasksRoute: Hashable, Codable, Sendable {
    case task(String)
    /// A task's subtasks as their own screen (#2868).
    case branch(String)
    case project(String)
    case projects
    case settings

    /// Screens with a floating "+" show the toast beside it themselves.
    var placesOwnToast: Bool {
        if case .project = self { return true }
        return false
    }

    var isTask: Bool {
        if case .task = self { return true }
        return false
    }
}

/// The vault shell's pages, so a route can switch to one. Raw values match
/// desktop's rail ids (`sidebar.railOrder`) and the saved launch tab.
enum VaultTab: String, Hashable, Sendable {
    case home, notes, inbox, tasks, journal, calendar
    /// Menu: Settings, and the pages that did not fit the bar
    /// (`VaultTabLayout`). The raw value predates the menu and stays, so a
    /// saved launch tab still reads.
    case more

    @MainActor var isShown: Bool {
        switch self {
        case .home, .notes, .more: true
        case .inbox: LocalSettings.shared.isOn(.inbox)
        case .tasks: LocalSettings.shared.isOn(.tasks)
        case .journal: LocalSettings.shared.isOn(.journal)
        case .calendar: LocalSettings.shared.isOn(.calendar)
        }
    }
}

/// Cross-tab navigation into the Tasks tab.
@MainActor
@Observable
final class TasksRouter {
    var selectedTab: VaultTab = .notes
    var path: [TasksRoute] = []
    /// Settings' stack (spec 006 ST20): Settings routes, and the notes a
    /// Settings page opens. As a stack, every page over the root list; as a
    /// split view, the pages over `settingsPage` in the detail column.
    var settingsPath = NavigationPath()
    /// The root row Settings' split view selects (#4348). `nil`, or a row
    /// the list does not show, shows the first row (`SettingsRootRows.page`).
    var settingsPage: SettingsRoute?
    /// Settings shows as a split view: the shell is at regular width.
    private(set) var settingsSplit = false
    /// The Calendar page's stack, wherever the page sits.
    var calendarPath = NavigationPath()

    /// The router for the vault ``LaunchSnapshot`` has open: the tab and the
    /// Tasks stack the user left.
    static func restored(from snapshot: LaunchSnapshot = .shared) -> TasksRouter {
        let router = TasksRouter()
        // A tab whose module was turned off since is not shown; stay on Notes.
        if let tab = snapshot.tab.flatMap(VaultTab.init(rawValue:)), tab.isShown { router.selectedTab = tab }
        router.path = snapshot.stack("tasks", as: [TasksRoute].self) ?? []
        return router
    }

    /// Every "… › settings" entry point: Menu › Settings, that section, and
    /// Back returns to the Settings root (flow lane 01).
    /// In the split view, a root row's page is selected and a page under
    /// one (Account › Devices) is pushed over its row's page.
    func openSettings(_ route: SettingsRoute) {
        selectedTab = .more
        var path = NavigationPath()
        if settingsSplit {
            if route != .root { settingsPage = route.section }
            if route != route.section { path.append(route) }
        } else if route != .root {
            path.append(route)
        }
        settingsPath = path
    }

    /// The shell changed width. The stack's root page carries over; a
    /// `NavigationPath` cannot be read, so the pages over it do not, and a
    /// stack's page is unknown to the split view, which keeps its selection.
    func setSettingsSplit(_ split: Bool) {
        guard split != settingsSplit else { return }
        settingsSplit = split
        var path = NavigationPath()
        if !split, let settingsPage { path.append(settingsPage) }
        settingsPath = path
    }

    /// Selects the Tasks tab and shows this task. The split view keeps the
    /// list column where it is and puts the task in the detail column.
    func openTask(_ id: String) {
        selectedTab = .tasks
        path = (tasksSplit ? listPath : []) + [.task(id)]
    }

    /// Pushes a route. In the split view a task replaces the detail column,
    /// and every other page goes on the list column.
    func open(_ route: TasksRoute) {
        selectedTab = .tasks
        guard tasksSplit else {
            path.append(route)
            return
        }
        if case let .task(id) = route { openTask(id) } else { listPath.append(route) }
    }

    // MARK: Split view (#4350)

    /// Tasks shows as a split view: the shell is at regular width.
    private(set) var tasksSplit = false

    func setTasksSplit(_ split: Bool) {
        guard split != tasksSplit else { return }
        tasksSplit = split
    }

    /// The list column's stack: the routes before the first task. A task
    /// pushed onto it by a link becomes the detail instead.
    var listPath: [TasksRoute] {
        get { Array(path.prefix { !$0.isTask }) }
        set { path = newValue.contains(where: \.isTask) ? newValue : newValue + path.drop { !$0.isTask } }
    }

    /// The detail column's task.
    var detailTask: String? {
        if case let .task(id) = path.first(where: \.isTask) { return id }
        return nil
    }

    /// The detail column's stack: what was opened from inside its task.
    var detailPath: [TasksRoute] {
        get { Array(path.drop { !$0.isTask }.dropFirst()) }
        set {
            guard let detailTask else { return }
            path = listPath + [.task(detailTask)] + newValue
        }
    }

    /// Closes the detail column's task, leaving the list where it is.
    func closeTask() {
        path = listPath
    }
}

