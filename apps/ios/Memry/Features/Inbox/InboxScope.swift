import Combine
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

/// The Inbox tab's navigation, so a notification can open the Inbox. At
/// compact width it is the stack. At regular width (#4349) `selection` is the
/// detail column's item and `path` stacks over it; an item is never pushed.
@MainActor
@Observable
final class InboxRouter {
    var path: [InboxRoute] = []
    private(set) var selection: InboxDetailSelection?
    private(set) var width: LayoutWidth = .compact
    /// An item opened from outside the Inbox (Calendar, a capture's "View",
    /// search), which may sit in another of its lists. The detail column
    /// switches the list to the one that holds it.
    private(set) var revealing: String?
    /// An item opened by hand that exists but no list holds: a filed capture
    /// (search's #4320 contract), one a type filter or an archived search
    /// hides, or one past the 200-row cap. It stays in the detail, as the
    /// pushed page does at compact width, until a list holds it or the user
    /// opens another.
    private(set) var unlisted: String?

    /// A row, a capture's "View" or a calendar link opened `id`.
    func open(_ id: String) {
        switch width {
        case .compact: path.append(.item(id))
        case .regular:
            selection = InboxDetailSelection(id: id, explicit: true)
            unlisted = nil
            path = []
        }
    }

    /// A notification or a Share hand-off: the list, with its first item in
    /// the detail column at regular width (D6). Neither names an item.
    func openInbox(in tasks: TasksRouter) {
        tasks.selectedTab = .inbox
        path = []
        selection = nil
        unlisted = nil
    }

    func openItem(_ id: String, in tasks: TasksRouter) {
        tasks.selectedTab = .inbox
        path = []
        open(id)
        if width == .regular { revealing = id }
    }

    /// The list now holds `revealing`, if any list does, in `order`.
    /// `exists` is false for an item gone from the vault.
    func revealed(_ order: [String], exists: Bool) {
        if exists, let revealing, selection?.id == revealing, !order.contains(revealing) { unlisted = revealing }
        revealing = nil
        follow(order, order)
    }

    /// The window crossed the regular rule: the item opened by hand stays
    /// open, pushed at compact width and selected at regular width.
    func adapt(to width: LayoutWidth) {
        guard width != self.width else { return }
        self.width = width
        unlisted = nil
        switch width {
        case .regular:
            // An item pushed by hand, or opened from outside before the tab
            // first showed, may sit in another list: reveal it.
            if case let .item(id) = path.last(where: \.isItem) {
                selection = InboxDetailSelection(id: id, explicit: true)
                revealing = id
            }
            path.removeAll(where: \.isItem)
        case .compact:
            if let selection, selection.explicit { path.insert(.item(selection.id), at: 0) }
            selection = nil
            revealing = nil
        }
    }

    /// The list beside the detail changed from `old` to `new` ids.
    func follow(_ old: [String], _ new: [String]) {
        guard revealing == nil else { return }
        if let unlisted {
            guard new.contains(unlisted) else { return }
            self.unlisted = nil
        }
        let next = InboxDetailSelection.next(after: selection, old: old, new: new)
        if next != selection { selection = next }
    }
}

/// The item in the detail column at regular width. `explicit` is false when
/// the app chose it (the first item, or the next one after a file, snooze,
/// archive or delete), and such an item is not marked viewed: desktop marks a
/// reminder viewed only when the user opens it, never when its list focus
/// moves (`use-inbox-keyboard.ts`, `reminder-detail.tsx`).
struct InboxDetailSelection: Equatable {
    let id: String
    let explicit: Bool

    /// Desktop's rule (`use-inbox-keyboard.ts`): an item that leaves the
    /// list hands the selection to the item after it, else the one before.
    /// No selection, or one the list never held (a capture deleted while the
    /// window was compact), takes the first item (`DESIGN.md` › Tablet, D6).
    static func next(after selection: Self?, old: [String], new: [String]) -> Self? {
        let auto = { (id: String) in Self(id: id, explicit: false) }
        guard let selection else { return new.first.map(auto) }
        if new.contains(selection.id) { return selection }
        guard let index = old.firstIndex(of: selection.id) else { return new.first.map(auto) }
        let kept = Set(new)
        let neighbor = old[(index + 1)...].first(where: kept.contains) ?? old[..<index].last(where: kept.contains)
        return (neighbor ?? new.first).map(auto)
    }
}

extension InboxRoute {
    var isItem: Bool {
        if case .item = self { return true }
        return false
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
    @Environment(\.requestVaultSync) private var requestVaultSync
    @Environment(\.vaultSyncPasses) private var syncPasses
    @State private var store: InboxStore?

    var body: some View {
        content()
            .environment(\.inboxStore, store)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, let store { Task { await store.load() } }
            }
            // The request is nil until the tasks store exists, which can be
            // after this store was made on a cold launch (#2910).
            .onChange(of: requestVaultSync == nil) { store?.requestSync = requestVaultSync }
            .onChange(of: store?.vaultId) { store?.requestSync = requestVaultSync }
            // Every pass, including one the realtime socket or another tab
            // asked for, may have pulled captures from another device.
            .onChange(of: syncPasses) {
                if let store { Task { await store.syncPassFinished() } }
            }
            // The redriver wrote files other devices captured (#4157).
            .onReceive(NotificationCenter.default.publisher(for: AttachmentRedriver.inboxFilesDownloaded).receive(on: DispatchQueue.main)) { _ in
                store?.inboxFilesDownloaded()
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
            made.requestSync = requestVaultSync
            store = made
            await made.load()
        } catch {
            Log.core.error("the inbox could not be opened", .code(ErrorMapping.userFacing(error).code))
        }
    }
}
