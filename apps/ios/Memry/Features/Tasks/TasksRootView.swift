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
}

/// The vault shell's tabs, so a route can switch to Tasks.
enum VaultTab: Hashable, Sendable {
    case notes, home, tasks, journal, more
}

/// Cross-tab navigation into the Tasks tab.
@MainActor
@Observable
final class TasksRouter {
    var selectedTab: VaultTab = .notes
    var path: [TasksRoute] = []

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
    @Environment(\.scenePhase) private var scenePhase

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
        .overlay(alignment: .bottom) { TasksToast(store: store) }
        .subtaskPrompts(store: store)
        .repeatPrompts(store: store)
        .task { await store.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.sync() } }
        }
    }
}

/// Builds the store for an opened vault, or explains why tasks cannot load.
struct TasksTabContent: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    let filler: (any VaultFilling)?
    @State private var store: TasksStore?
    @State private var failure: UserFacingError?

    var body: some View {
        Group {
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
        .task(id: vault.id()) { make() }
    }

    private func make() {
        guard store == nil else { return }
        guard let secureStore else {
            failure = ErrorMapping.userFacing(SyncError.Locked)
            return
        }
        do {
            let tasks = try vault.tasks(store: secureStore)
            store = TasksStore(core: tasks, filler: filler, vaultId: vault.id())
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}
