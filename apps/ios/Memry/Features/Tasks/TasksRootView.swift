import MemryCore
import Observation
import SwiftUI

// TP031. The Tasks tab: one navigation stack over the task list, with routes
// to a task, a project hub, the projects list and the task settings.
//
// **Opening a task by id** (search results, a task block in a note, a reminder
// notification) goes through ``TasksRouter``: it selects the Tasks tab and
// replaces the stack with that task's detail. A task that no longer exists
// opens a sensible "not in this vault" state inside the detail rather than
// crashing or showing a ghost (FR-061).

/// A place inside the Tasks tab.
enum TasksRoute: Hashable, Sendable {
    case task(String)
    case project(String)
    case projects
    case settings

    /// Screens with a floating "+" show the toast beside it themselves.
    var placesOwnToast: Bool {
        if case .project = self { return true }
        return false
    }
}

/// The vault shell's tabs, so a route can switch to Tasks.
enum VaultTab: Hashable, Sendable {
    case notes, inbox, tasks, journal, more
}

/// Cross-tab navigation into the Tasks tab.
@MainActor
@Observable
final class TasksRouter {
    var selectedTab: VaultTab = .notes
    var path: [TasksRoute] = []
    /// The More tab's stack (spec 006 ST20): Settings routes, and the notes
    /// a Settings page opens.
    var settingsPath = NavigationPath()

    /// Every "… › settings" entry point: the More tab, that section, and Back
    /// returns to the Settings root (flow lane 01).
    func openSettings(_ route: SettingsRoute) {
        selectedTab = .more
        var path = NavigationPath()
        path.append(SettingsRoute.root)
        if route != .root { path.append(route) }
        settingsPath = path
    }

    /// Selects the Tasks tab and shows this task.
    func openTask(_ id: String) {
        selectedTab = .tasks
        path = [.task(id)]
    }

    func open(_ route: TasksRoute) {
        selectedTab = .tasks
        path.append(route)
    }
}

/// The Tasks tab's content for one opened vault.
struct TasksRootView: View {
    let store: TasksStore
    @Environment(TasksRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            TaskListScreen(store: store)
                .navigationDestination(for: TasksRoute.self) { route in
                    switch route {
                    case let .task(id):
                        TaskDetailView(taskId: id, store: store)
                    case let .project(id):
                        ProjectHubView(projectId: id, store: store)
                    case .projects:
                        ProjectsListView(store: store)
                    case .settings:
                        TaskSettingsView(store: store)
                    }
                }
        }
        // The list places its own toast beside the "+" (RD15); every pushed
        // screen shows it here, over the tab bar.
        .overlay(alignment: .bottom) {
            // The hub places its own beside its "+" (RD18).
            if let top = router.path.last, !top.placesOwnToast {
                TasksToast(store: store)
                    .padding(.horizontal, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.medium)
            }
        }
        .subtaskPrompts(store: store)
        .repeatPrompts(store: store)
        .task {
            await store.load()
            await store.openOnDefaultView()
        }
        // A task ticked in a note, or opened from search, changed the vault
        // while another tab showed: coming back re-reads it.
        .onChange(of: router.selectedTab) { _, tab in
            if tab == .tasks { Task { await store.refresh() } }
        }
    }
}

/// Builds the vault's tasks store as soon as the vault opens, not when the
/// Tasks tab is first shown (`TabView` builds tabs lazily): reminder
/// notifications (TP053, FR-062) refill from this store at launch and on every
/// foreground, whichever tab is showing.
struct VaultTasksScope<Content: View>: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    let filler: (any VaultFilling)?
    @ViewBuilder let content: (TasksStore?, UserFacingError?) -> Content
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: TasksStore?
    @State private var failure: UserFacingError?

    var body: some View {
        content(store, failure)
            .environment(\.requestVaultSync, syncRequest)
            // Pull and push on every return to the foreground, whichever tab
            // shows: a tab's own views miss scene changes while hidden. The
            // pass for the vault opening runs from `make()`, because the
            // scene can already be active before the store exists.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, let store { Task { await store.sync() } }
            }
            .background {
                if let store {
                    Color.clear.reminderScheduling(store: store)
                }
            }
            .task(id: vault.id()) { make() }
    }

    private var syncRequest: (@MainActor () -> Void)? {
        guard let store else { return nil }
        return { store.scheduleSync() }
    }

    private func make() {
        // One store per vault: a store for another vault must never take this
        // vault's writes.
        guard store?.vaultId != vault.id() else { return }
        store = nil
        failure = nil
        guard let secureStore else {
            failure = ErrorMapping.userFacing(SyncError.Locked)
            return
        }
        do {
            let tasks = try vault.tasks(store: secureStore)
            let made = TasksStore(core: tasks, filler: filler, vaultId: vault.id())
            store = made
            Task { await made.sync() }
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}

/// The Tasks tab: the store's screens, or why there are none.
struct TasksTabContent: View {
    let store: TasksStore?
    let failure: UserFacingError?

    var body: some View {
        if let store {
            TasksRootView(store: store)
        } else if let failure {
            NavigationStack {
                ErrorNotice(error: failure, code: nil)
                    .padding(Tokens.Space.screenInline)
                    .navigationTitle(TasksCopy.title)
            }
        } else {
            ProgressView(TasksCopy.loading)
        }
    }
}

extension EnvironmentValues {
    /// Asks for a sync pass soon (debounced, one at a time, through the tasks
    /// store). A write made outside the Tasks tab, such as ticking a task line
    /// in a note, would otherwise wait in the outbox until the next pass.
    @Entry var requestVaultSync: (@MainActor () -> Void)?
}
