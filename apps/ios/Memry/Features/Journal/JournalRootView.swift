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
            if !syncing, let store { Task { await store.refresh() } }
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
            store = made
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
