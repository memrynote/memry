import MemryCore
import Observation
import SwiftUI

// IB033 (D1). Where the Inbox lives: a row at the top of the More tab with
// the unprocessed count, opening a pushed screen; the tab bar is unchanged.
// Notifications, the Share extension hand-off and (later) a widget open it
// through ``InboxLinks``.

/// A place inside the More tab's stack.
enum MoreRoute: Hashable, Sendable {
    case inbox
    case item(String)
    case inboxSettings
}

/// The More tab's stack, so a notification can push the Inbox.
@MainActor
@Observable
final class InboxRouter {
    var path: [MoreRoute] = []

    func openInbox(in tasks: TasksRouter) {
        tasks.selectedTab = .more
        path = [.inbox]
    }

    func openItem(_ id: String, in tasks: TasksRouter) {
        tasks.selectedTab = .more
        path = [.inbox, .item(id)]
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

/// The More tab's Inbox row (D1): glyph, name, unprocessed count.
struct InboxMoreRow: View {
    let store: InboxStore?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Tokens.Space.medium) {
                Image(systemName: "tray")
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityHidden(true)
                Text(InboxCopy.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: Tokens.Space.small)
                if let count = store?.stats?.reviewable, count > 0 {
                    Text("\(count)")
                        .font(Tokens.Typography.supporting.font.monospacedDigit())
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                Image(systemName: "chevron.forward")
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.vertical, Tokens.Space.small)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(InboxCopy.moreRowAccessibility(Int(store?.stats?.reviewable ?? 0)))
        .accessibilityIdentifier("inbox.more.row")
        .disabled(store == nil)
    }
}
