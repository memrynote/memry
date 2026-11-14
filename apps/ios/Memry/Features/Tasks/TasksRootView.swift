import Combine
import MemryCore
import Observation
import SwiftUI

// TP031. The Tasks tab: one navigation stack over the task list, with routes
// to a task, a project hub, the projects list and the task settings. At
// regular width it is a split view instead (`TasksSplitView`, #4350). Both
// read the one path on ``TasksRouter``.

/// The Tasks tab's content for one opened vault.
struct TasksRootView: View {
    let store: TasksStore
    @Environment(TasksRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var width: LayoutWidth {
        LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    var body: some View {
        @Bindable var router = router
        Group {
            if width == .regular {
                TasksSplitView(store: store)
            } else {
                NavigationStack(path: $router.path) {
                    TaskListScreen(store: store)
                        .tasksDestinations(store: store)
                }
                // The list places its own toast beside the "+" (RD15); every
                // pushed screen shows it here, over the tab bar.
                .tasksToast(store: store, over: router.path)
            }
        }
        .onChange(of: width, initial: true) { _, width in router.setTasksSplit(width == .regular) }
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

extension View {
    /// Every page the Tasks tab pushes.
    func tasksDestinations(store: TasksStore) -> some View {
        navigationDestination(for: TasksRoute.self) { route in
            switch route {
            case let .task(id):
                TaskDetailView(taskId: id, store: store)
            case let .branch(id):
                TaskBranchView(parentId: id, store: store)
            case let .project(id):
                ProjectHubView(projectId: id, store: store)
            case .projects:
                ProjectsListView(store: store)
            case .settings:
                TaskSettingsView(store: store)
            }
        }
    }

    /// The Undo toast over a pushed page. The list and the hub place their
    /// own beside their "+" (RD15, RD18).
    func tasksToast(store: TasksStore, over path: [TasksRoute]) -> some View {
        overlay(alignment: .bottom) {
            if let top = path.last, !top.placesOwnToast {
                TasksToast(store: store)
                    .padding(.horizontal, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.medium)
            }
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
    @State private var searchIndex: VaultSearchIndex?

    var body: some View {
        content(store, failure)
            .environment(\.requestVaultSync, syncRequest)
            .environment(\.vaultSyncPasses, store?.syncPasses ?? 0)
            .environment(\.vaultSearchIndex, searchIndex)
            // A pass may have pulled records and bodies the index has not seen.
            .onChange(of: store?.syncPasses) { searchIndex?.schedule() }
            .environment(\.vaultProjects, store?.projects ?? [])
            .environment(\.whiteboards, secureStore.map { CoreWhiteboardBoards(vault: vault, store: $0, executor: .shared) })
            // Pull and push on every return to the foreground, whichever tab
            // shows: a tab's own views miss scene changes while hidden. The
            // pass for the vault opening runs from `make()`, because the
            // scene can already be active before the store exists.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, let store { Task { await store.sync() } }
            }
            // Reconnect: retry attachments a dead path left missing (#3261).
            .onReceive(NotificationCenter.default.publisher(for: PathReachability.attachmentPathChanged).receive(on: DispatchQueue.main)) { _ in
                if let attachments = store?.attachments { Task { await attachments.redrive() } }
            }
            // A body pull outside a pass (a page, a portal, a share) landed content.
            .onReceive(NotificationCenter.default.publisher(for: VaultSearchIndex.bodyLanded).receive(on: DispatchQueue.main)) { _ in
                searchIndex?.schedule()
            }
            .background {
                if let store {
                    Color.clear.reminderScheduling(store: store)
                }
            }
            .task(id: vault.id()) { make() }
            // The realtime socket, foreground only (chapter 09 §9.1): without
            // it a remote change waits for this device's next pass (#2798).
            // Keyed on `.background`, not `.active`: Control Center or a
            // notification banner makes the scene `.inactive` for a moment,
            // and reconnecting after each is a handshake for nothing.
            .task(id: RealtimeKey(vault: vault.id(), foreground: scenePhase != .background, store: store?.vaultId)) {
                await holdRealtime()
            }
    }

    private struct RealtimeKey: Equatable {
        let vault: String
        let foreground: Bool
        let store: String?
    }

    /// Runs until the scene goes to the background or the store changes;
    /// SwiftUI cancels the task, and the cancel stops the socket.
    private func holdRealtime() async {
        guard scenePhase != .background, let store,
              let realtime = filler?.realtime(onChanges: { store.scheduleSync() })
        else { return }
        let terminal = await withTaskCancellationHandler {
            await realtime.run()
        } onCancel: {
            realtime.stop()
        }
        // §9.9's 4004 or 4009, latched in the core for this vault's sync. The
        // pass meets the same refusal over HTTP, and its error is the one the
        // app already shows for a revoked device or an outdated build.
        if terminal {
            Log.sync.notice("realtime socket stopped for good")
            store.scheduleSync()
        }
    }

    private var syncRequest: (@MainActor () -> Void)? {
        guard let store else { return nil }
        return { [searchIndex] in
            store.scheduleSync()
            searchIndex?.schedule()
        }
    }

    private func make() {
        // One store per vault: a store for another vault must never take this
        // vault's writes.
        guard store?.vaultId != vault.id() else { return }
        store = nil
        failure = nil
        // A vault whose index will not open still browses; its screens then
        // have no search, as `VaultBrowseViewModel` does.
        searchIndex = (try? CoreVaultSearch(vault: vault, executor: .shared)).map { VaultSearchIndex(search: $0) }
        searchIndex?.schedule()
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

    /// How many sync passes have finished in this vault. A screen that shows
    /// a record or body another device edits re-reads when it changes.
    @Entry var vaultSyncPasses: Int = 0

    /// The vault's projects, archived ones included, for screens outside the
    /// Tasks tab such as a note's `project` property.
    @Entry var vaultProjects: [ProjectItem] = []
}
