import MemryCore
import SwiftUI

// Spec 006 ST20/ST22. Builds the Settings context once per opened vault, next
// to the tasks store, and keeps it fresh: synced settings re-read after every
// sync pass and on each return to the foreground.
struct VaultSettingsScope<Content: View>: View {
    let vault: Vault
    let model: VaultSelectionViewModel
    let tasks: TasksStore?
    @ViewBuilder let content: (SettingsContext?, VaultBrowseViewModel?) -> Content
    @Environment(\.scenePhase) private var scenePhase
    @State private var context: SettingsContext?
    @State private var browse: VaultBrowseViewModel?

    var body: some View {
        content(context, browse)
            .memryAppearance()
            .task(id: tasks?.vaultId) { await make() }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, let context else { return }
                Task { await context.store.refreshIfChanged() }
            }
    }

    private func make() async {
        guard let tasks, context?.vaultId != vault.id(), let secureStore = model.secureStore else { return }
        do {
            let settings = try vault.settings(store: secureStore)
            let content = try vault.tasks(store: secureStore)
            let store = SettingsStore(core: settings)
            store.requestSync = { tasks.scheduleSync() }
            let account = AccountModel(session: model.session, filler: model.filler)
            let made = SettingsContext(
                store: store,
                tasks: tasks,
                content: content,
                notes: vault.notes(),
                account: account,
                vaults: model,
                vaultId: vault.id()
            )
            tasks.syncFinished = { succeeded in
                account.syncFinished(succeeded)
                Task { await store.refreshIfChanged() }
            }
            browse = VaultBrowseViewModel(vault: vault, executor: .shared, filler: model.filler, store: secureStore)
            context = made
            await store.load()
            await account.load()
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.core.error("settings could not be opened for this vault", .code(mapped.code))
        }
    }
}
