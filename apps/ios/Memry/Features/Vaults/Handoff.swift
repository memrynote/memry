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
// another vault opens nothing: it shows the missing state and never switches
// vaults.

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
    /// vault. Returns the kind whose missing state to show otherwise.
    @MainActor
    func open(openVault: String, tasks: TasksRouter, journal: JournalRouter, notes: NotesLinks) -> HandoffItem.Kind? {
        guard vaultId == openVault else { return item.kind }
        switch item {
        case let .note(id):
            tasks.selectedTab = .notes
            notes.open(id)
        case let .journalDay(date):
            journal.tabs = tasks
            journal.openDay(date)
        case let .task(id):
            tasks.openTask(id)
        }
        return nil
    }
}

/// A continued activity that arrives before the vault shell exists (sign-in,
/// unlock, the vault list) waits here.
@MainActor
@Observable
final class HandoffLinks {
    static let shared = HandoffLinks()
    private(set) var pending: HandoffActivity?

    /// `false` when the activity is not one of ours or Handoff is off here.
    @discardableResult
    func request(_ activity: NSUserActivity, defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: HandoffActivity.settingKey) as? Bool ?? true else { return false }
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

/// An activity from another vault: the item's missing state, nothing opened.
struct HandoffMissingView: View {
    let kind: HandoffItem.Kind
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch kind {
                case .note: NoteMissingNotice()
                case .task: TaskDetailMissing()
                case .journal:
                    ContentUnavailableView {
                        Label(HandoffCopy.dayMissingTitle, systemImage: "calendar.badge.exclamationmark")
                    } description: {
                        Text(HandoffCopy.dayMissingDetail)
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
    static let done = "Done"
}
