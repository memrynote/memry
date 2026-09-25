import MemryCore
import Observation
import SwiftUI

// IB033 (D1, revised). Where the Inbox lives: its own tab, in the slot the
// Home placeholder held; the list is the tab's root. Notifications, the Share
// extension hand-off and (later) a widget open it through ``InboxLinks``.

/// A place pushed on the Inbox tab's stack.
enum InboxRoute: Hashable, Sendable {
    case item(String)
    case inboxSettings
}

/// The Inbox tab's stack, so a notification can open the Inbox.
@MainActor
@Observable
final class InboxRouter {
    var path: [InboxRoute] = []

    func openInbox(in tasks: TasksRouter) {
        tasks.selectedTab = .inbox
        path = []
    }

    func openItem(_ id: String, in tasks: TasksRouter) {
        tasks.selectedTab = .inbox
        path = [.item(id)]
    }
}

/// A request to open the Inbox from outside the view tree (a tapped
/// notification, a Share extension hand-off), waiting until a vault shell
/// exists to take it.
@MainActor
@Observable
final class InboxLinks {
    static let shared = InboxLinks()
    private(set) var pending = false

    func request() { pending = true }

    func take() -> Bool {
        defer { pending = false }
        return pending
    }
}

/// `Application Support/<bundle>/vault/<vaultId>`: the layout `VaultFiles`
/// keeps (data-model §A.0), where `attachments/inbox/{id}/` sits.
enum InboxFiles {
    static func vaultDirectory(_ vaultId: String) -> URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              let bundle = Bundle.main.bundleIdentifier, !bundle.isEmpty,
              !vaultId.isEmpty, !vaultId.contains("/"), vaultId != ".", vaultId != ".."
        else { return nil }
        return support
            .appendingPathComponent(bundle, isDirectory: true)
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
    }
}

extension EnvironmentValues {
    /// The vault's inbox, when the keychain let one be built.
    @Entry var inboxStore: InboxStore?
}

/// Builds the vault's inbox store when the vault opens (the review nudge and
/// snooze-due notifications refill from it whichever tab shows).
struct VaultInboxScope<Content: View>: View {
    let vault: Vault
    let secureStore: (any SecureStore)?
    let filler: (any VaultFilling)?
    @ViewBuilder let content: () -> Content
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: InboxStore?

    var body: some View {
        content()
            .environment(\.inboxStore, store)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, let store { Task { await store.load() } }
            }
            .task(id: vault.id()) { await make() }
    }

    private func make() async {
        guard store?.vaultId != vault.id() else { return }
        store = nil
        guard let secureStore else { return }
        do {
            let inbox = try vault.inbox(store: secureStore)
            let made = InboxStore(
                core: inbox,
                vaultId: vault.id(),
                vaultDirectory: InboxFiles.vaultDirectory(vault.id()),
                filler: filler,
                notes: vault.notes(),
                writer: try? vault.notesWriter(store: secureStore),
                tasks: try? vault.tasks(store: secureStore)
            )
            made.shareRoot = ShareQueue.groupRoot()
            store = made
            await made.load()
        } catch {
            Log.core.error("the inbox could not be opened", .code(ErrorMapping.userFacing(error).code))
        }
    }
}
