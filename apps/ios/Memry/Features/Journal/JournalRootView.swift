import MemryCore
import SwiftUI

// JP031. The Journal tab's content for one opened vault: the store, the one
// stack (Year › Month › Day) and what restores it. Opening the tab with no
// saved stack lands on today (desktop opens on today).

/// The Journal tab: the store's screens, or why there are none.
struct JournalTabContent: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    /// The vault's sync pass is running; its end re-reads what is shown.
    let isSyncing: Bool
    /// The vault's tasks store, for the Day section.
    var tasksStore: TasksStore?
    /// The vault's sync, for on-demand body fetches and attachments.
    var filler: (any VaultFilling)?

    @Environment(\.requestVaultSync) private var requestVaultSync
    @Environment(JournalRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @SceneStorage("journal.stack") private var savedStack = ""
    @State private var store: JournalStore?
    @State private var failure: UserFacingError?

    var body: some View {
        Group {
            if let store {
                JournalRootView(store: store)
                    .environment(\.journalTasks, tasksStore)
                    // Once for the tab: the Day screen keeps three pages
                    // alive, and each binding its own would present twice.
                    .modifier(JournalSubtaskPrompts(tasks: tasksStore))
                    .overlay(alignment: .bottom) {
                        JournalToast(store: store)
                            .padding(.horizontal, Tokens.Space.inset)
                            .padding(.bottom, Tokens.Space.medium)
                    }
            } else if let failure {
                NavigationStack {
                    ErrorNotice(error: failure, code: nil)
                        .padding(Tokens.Space.screenInline)
                        .navigationTitle(JournalCopy.title)
                }
            } else {
                ProgressView(JournalCopy.loading)
            }
        }
        .task(id: vault.id()) { make() }
        .onChange(of: isSyncing) { _, syncing in
            if !syncing, let store {
                Task {
                    // Backlinks and link resolution read the search index,
                    // which only a reindex brings up to date (incremental).
                    await Self.reindex(store)
                    await store.syncFinished()
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store?.clock.refresh() }
        }
        .onChange(of: router.saved) { _, saved in savedStack = saved }
    }

    private func make() {
        guard store?.vaultId != vault.id() else { return }
        store = nil
        failure = nil
        guard let secureStore else {
            failure = ErrorMapping.userFacing(SyncError.Locked)
            return
        }
        do {
            let clock = JournalClock()
            clock.start()
            let made = JournalStore(core: try vault.journal(store: secureStore), clock: clock, vaultId: vault.id())
            made.requestSync = requestVaultSync
            made.context = Self.context(vault: vault, secureStore: secureStore, filler: filler)
            store = made
            Task { await Self.reindex(made) }
            // A route that arrived first (a reminder tap on a cold start) wins
            // over the saved stack; with neither, the tab opens on today.
            if router.path.isEmpty, !router.restore(savedStack) {
                router.showDay(clock.today)
            }
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}

extension JournalTabContent {
    /// Brings the search index up to date; a failure leaves a stale index,
    /// which still answers.
    static func reindex(_ store: JournalStore) async {
        do {
            try await store.context?.search?.reindex()
        } catch {
            Log.storage.error("the search index could not be brought up to date")
        }
    }

    /// The note page's dependencies, built as `VaultBrowseViewModel` builds
    /// them for the Notes tab.
    static func context(
        vault: Vault,
        secureStore: any SecureStore,
        filler: (any VaultFilling)?
    ) -> JournalVaultContext {
        let executor = CoreExecutor.shared
        return JournalVaultContext(
            reader: CoreNotesReader(vault: vault, executor: executor),
            filler: filler,
            writer: CoreNotesWriter(vault: vault, store: secureStore, executor: executor),
            editor: CoreBlockEditor(vault: vault, store: secureStore, executor: executor),
            metadataWriter: CoreNoteMetadataWriter(vault: vault, store: secureStore, executor: executor),
            search: try? CoreVaultSearch(vault: vault, executor: executor),
            noteTasks: CoreNoteTasks(vault: vault, store: secureStore, executor: executor)
        )
    }
}

/// The stack: Year at the root, Month and Day pushed over it.
struct JournalRootView: View {
    let store: JournalStore
    @Environment(JournalRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            JournalYearScreen(store: store)
                .navigationDestination(for: JournalRoute.self) { route in
                    switch route {
                    case let .month(year, month):
                        JournalMonthScreen(store: store, year: year, month: month)
                    case let .day(date):
                        JournalDayScreen(store: store, date: date)
                    case .settings:
                        JournalSettingsScreen(store: store)
                    case let .note(id):
                        if let context = store.context {
                            NoteReadView(
                                route: NoteRoute(id: id),
                                reader: context.reader,
                                filler: context.filler,
                                editor: context.editor,
                                metadataWriter: context.metadataWriter,
                                writer: context.writer,
                                search: context.search,
                                open: { router.path.append(.note($0.id)) },
                                noteTasks: context.noteTasks
                            )
                        }
                    }
                }
        }
        .onChange(of: store.clock.today) { old, new in
            // Midnight passed while the tab showed "today": follow it, as
            // desktop's day page does when the date changes under it.
            if router.shownDay == old { router.showDay(new) }
        }
    }
}
