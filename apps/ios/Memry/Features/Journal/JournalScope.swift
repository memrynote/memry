import MemryCore
import SwiftUI

// JP031, #4380. The vault's journal store, built when the vault opens, next
// to the tasks and calendar stores: the Journal page and the Day Panel beside
// every other page read the same store (`\.journalStore`).

struct VaultJournalScope<Content: View>: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    /// The vault's sync pass is running; its end re-reads what is shown.
    let isSyncing: Bool
    /// The vault's tasks store, for the day's tasks.
    let tasksStore: TasksStore?
    /// The vault's sync, for on-demand body fetches and attachments.
    let filler: (any VaultFilling)?
    @ViewBuilder let content: () -> Content

    @Environment(\.requestVaultSync) private var requestVaultSync
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.quickCapture) private var capture
    @State private var store: JournalStore?
    @State private var failure: UserFacingError?

    var body: some View {
        content()
            .environment(\.journalStore, store)
            .environment(\.journalStoreFailure, failure)
            .environment(\.journalTasks, tasksStore)
            .task(id: vault.id()) { make() }
            // The sync request is nil until the tasks store exists, which can be
            // after this store was made on a cold launch.
            .onChange(of: requestVaultSync == nil) { store?.requestSync = requestVaultSync }
            // And once the store exists: `make()` runs in a task that may hold a
            // render from before the request arrived, and the change above found
            // no store to hand it to (#2910).
            .onChange(of: store?.vaultId) { store?.requestSync = requestVaultSync }
            .onChange(of: isSyncing) { _, syncing in
                if !syncing, let store {
                    Task { await store.syncFinished() }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { store?.clock.refresh() }
            }
            // A capture wrote today's day outside this store: re-read.
            .onChange(of: capture?.journalWrites) {
                Task { await store?.refresh() }
            }
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
            made.context = JournalTabContent.context(vault: vault, secureStore: secureStore, filler: filler)
            store = made
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}

extension EnvironmentValues {
    /// The vault's journal, for the Journal page and the Day Panel.
    @Entry var journalStore: JournalStore?
    /// Why the vault's journal could not be opened.
    @Entry var journalStoreFailure: UserFacingError?
}
