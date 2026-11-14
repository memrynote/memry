import Foundation
import Observation
import SwiftUI

// #4381. Handoff of the open note, journal day or task between this user's
// devices. The system keeps an advertised activity outside the vault, so its
// payload holds identifiers only, never a title or body text (the notification
// text rule, `apps/ios/AGENTS.md` › Swift, R12).
//
// A page that shows an item advertises it with `.handoff(_:)` while it is on
// screen. The other device continues it through the shell's routers, the way
// a search hit or a reminder tap opens the item; an item that has not synced
// there yet lands on its page's existing missing state. An activity from
// another vault, or for a page turned off on this device, opens nothing: it
// shows a missing sheet and never switches vaults.
//
// The device's Handoff setting only stops this device advertising. It still
// continues what the user's other devices hand off (Kaan, #4610).

/// The item an activity names.
enum HandoffItem: Hashable, Sendable {
    case note(String)
    /// A journal day, `YYYY-MM-DD`. Addressed by date, never by record id.
    case journalDay(String)
    case task(String)

    enum Kind: String, Hashable, Identifiable, Sendable {
        case note, journal, task
        var id: String { rawValue }
    }

    var kind: Kind {
        switch self {
        case .note: .note
        case .journalDay: .journal
        case .task: .task
        }
    }

    var id: String {
        switch self {
        case let .note(id), let .journalDay(id), let .task(id): id
        }
    }
}

/// One advertised activity: the vault and the item in it.
///
/// The `userInfo` keys cross builds: two devices on different app versions
/// hand off to each other, so a key is never renamed, and a kind this build
/// does not know is ignored rather than guessed at.
struct HandoffActivity: Hashable, Sendable {
    static let type = "com.memrynote.app.open-item"
    /// Per device, never synced. Absent means on.
    static let settingKey = "settings.handoff"

    let vaultId: String
    let item: HandoffItem

    private enum Key {
        static let vault = "vault"
        static let kind = "kind"
        static let id = "id"
    }

    var userInfo: [String: String] {
        [Key.vault: vaultId, Key.kind: item.kind.rawValue, Key.id: item.id]
    }

    init(vaultId: String, item: HandoffItem) {
        self.vaultId = vaultId
        self.item = item
    }

    init?(userInfo: [AnyHashable: Any]?) {
        guard let vaultId = userInfo?[Key.vault] as? String, !vaultId.isEmpty,
              let raw = userInfo?[Key.kind] as? String, let kind = HandoffItem.Kind(rawValue: raw),
              let id = userInfo?[Key.id] as? String, !id.isEmpty else { return nil }
        switch kind {
        case .note: item = .note(id)
        case .task: item = .task(id)
        case .journal:
            guard JournalDates.date(id) != nil else { return nil }
            item = .journalDay(id)
        }
        self.vaultId = vaultId
    }

    init?(_ activity: NSUserActivity) {
        guard activity.activityType == Self.type else { return nil }
        self.init(userInfo: activity.userInfo)
    }

    /// Fills the activity SwiftUI advertises. No title: the system shows the
    /// app's name, and a title would carry note text out of the vault.
    func configure(_ activity: NSUserActivity) {
        activity.title = nil
        activity.userInfo = userInfo
        activity.requiredUserInfoKeys = Set(userInfo.keys)
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = false
        activity.isEligibleForPrediction = false
    }

    /// Opens the item through the shell's routers when `openVault` is its
    /// vault and its page is shown here. Returns why it opened nothing
    /// otherwise.
    @MainActor
    func open(
        openVault: String,
        isShown: (VaultTab) -> Bool,
        tasks: TasksRouter,
        journal: JournalRouter,
        notes: NotesLinks
    ) -> HandoffMissing? {
        guard vaultId == openVault else { return .otherVault(item.kind) }
        switch item {
        case let .note(id):
            tasks.selectedTab = .notes
            notes.open(id)
        case let .journalDay(date):
            guard isShown(.journal) else { return .pageOff(.journal) }
            journal.tabs = tasks
            journal.openDay(date)
        case let .task(id):
            guard isShown(.tasks) else { return .pageOff(.tasks) }
            tasks.openTask(id)
        }
        return nil
    }
}

/// Why a continued activity opened nothing.
enum HandoffMissing: Hashable, Identifiable {
    /// The item is in another vault.
    case otherVault(HandoffItem.Kind)
    /// The item's page is turned off on this device (Settings › Features).
    case pageOff(VaultTab)

    var id: Self { self }
}

/// A continued activity that arrives before the vault shell exists (sign-in,
/// unlock, the vault list) waits here.
@MainActor
@Observable
final class HandoffLinks {
    static let shared = HandoffLinks()
    private(set) var pending: HandoffActivity?

    /// `false` when the activity is not one of ours. The Handoff setting does
    /// not apply: it only stops this device advertising.
    @discardableResult
    func request(_ activity: NSUserActivity) -> Bool {
        guard let continued = HandoffActivity(activity) else {
            Log.app.notice("a handoff activity could not be read")
            return false
        }
        pending = continued
        return true
    }

    func take() -> HandoffActivity? {
        defer { pending = nil }
        return pending
    }
}

extension EnvironmentValues {
    /// The open vault's id, set by the vault shell. `nil` outside a vault.
    @Entry var handoffVaultId: String?
}

extension View {
    /// Advertises `item` for Handoff while this page is on screen and the
    /// device's Handoff setting is on.
    func handoff(_ item: HandoffItem) -> some View {
        modifier(HandoffAdvertiser(item: item))
    }
}

private struct HandoffAdvertiser: ViewModifier {
    let item: HandoffItem
    @Environment(\.handoffVaultId) private var vaultId
    @AppStorage(HandoffActivity.settingKey) private var enabled = true
    /// A page pushed over, or a tab not selected, is not on screen.
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .onAppear { shown = true }
            .onDisappear { shown = false }
            .userActivity(HandoffActivity.type, isActive: enabled && shown && vaultId != nil) { activity in
                guard let vaultId else { return }
                HandoffActivity(vaultId: vaultId, item: item).configure(activity)
                Log.app.debug("handoff activity advertised")
            }
    }
}

extension View {
    /// Shows `missing` once nothing else is presented. SwiftUI drops a sheet
    /// asked for while another is up and leaves its binding set, so this waits
    /// for the open sheet (Menu, search, an editor) to close instead of
    /// closing it, which could discard what the user is typing there.
    func handoffMissingSheet(_ missing: Binding<HandoffMissing?>) -> some View {
        modifier(HandoffMissingSheet(pending: missing))
    }
}

private struct HandoffMissingSheet: ViewModifier {
    @Binding var pending: HandoffMissing?
    @State private var shown: HandoffMissing?

    func body(content: Content) -> some View {
        content
            .task(id: pending) {
                guard let missing = pending else { return }
                while MemryCommands.isPresenting {
                    do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                }
                pending = nil
                shown = missing
            }
            .sheet(item: $shown) { HandoffMissingView(missing: $0) }
    }
}

/// A continued activity that opened nothing: the item's missing state, or
/// its page turned off here.
struct HandoffMissingView: View {
    let missing: HandoffMissing
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch missing {
                case .otherVault(.note): NoteMissingNotice()
                case .otherVault(.task): TaskDetailMissing()
                case .otherVault(.journal):
                    ContentUnavailableView {
                        Label(HandoffCopy.dayMissingTitle, systemImage: "calendar.badge.exclamationmark")
                    } description: {
                        Text(HandoffCopy.dayMissingDetail)
                    }
                case let .pageOff(page):
                    ContentUnavailableView {
                        Label(HandoffCopy.pageOffTitle(page), systemImage: "eye.slash")
                    } description: {
                        Text(HandoffCopy.pageOffDetail)
                    }
                }
            }
            .padding(Tokens.Space.inset)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(HandoffCopy.done) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
        .accessibilityIdentifier("handoff.missing")
    }
}

enum HandoffCopy {
    static let dayMissingTitle = "This day is not in this vault"
    static let dayMissingDetail = "It was open in another vault on your other device."
    static func pageOffTitle(_ page: VaultTab) -> String { "\(page.title) is off on this \(ThisDevice.noun)" }
    static let pageOffDetail = "Turn it on in Settings › Features to open what your other device handed off."
    static let done = "Done"
}
