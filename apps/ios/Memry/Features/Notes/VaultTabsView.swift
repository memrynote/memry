import MemryCore
import SwiftUI

// The shell an opened vault lives in: Notes, Inbox, Tasks, Journal, More,
// with the tabs that are not built yet saying so. Inbox, Tasks and Journal hide
// when turned off in Settings › Features (settings spec ST44).
//
// **A tab that is not built says what is true, and is not removed.** Kaan's
// call: ship the bar now. `DESIGN.md` forbids a dead control, not an honest
// limitation — "If a feature is intentionally unavailable on mobile, show a
// clear limitation instead of a dead control or a partial imitation" — so each
// unbuilt tab opens a screen that names the feature, says where it works
// today, and promises no date.
//
// **The bar is the platform's.** `TabView` with `Tab` gets the system's own
// bar, which on this OS is glass, adapts to the keyboard, collapses on scroll
// and carries the accessibility semantics. Nothing here asks for a material.
//
// **Only the Notes tab owns a stack.** `NotesListView` has its own
// `NavigationStack` and the two `navigationDestination` registrations research
// R15 requires; a second stack wrapped around it here would push its screens
// into the wrong one.

struct VaultTabsView<Notes: View, Tasks: View, More: View>: View {
    @ViewBuilder let notes: () -> Notes
    /// The Tasks tab (spec 004 TP031), built by the caller that holds the
    /// vault, keychain and sync.
    @ViewBuilder let tasks: () -> Tasks
    /// More › Settings (settings spec F1), built by the caller with the
    /// vault's settings context.
    @ViewBuilder let more: () -> More
    /// Cross-tab navigation: search, note task blocks and reminder taps open a
    /// task through it.
    @State private var router = TasksRouter()
    /// The Inbox tab's stack (inbox spec D1).
    @State private var inboxRouter = InboxRouter()
    private let inboxLinks = InboxLinks.shared
    @Environment(\.inboxStore) private var inboxStore
    /// Features (settings spec ST44): a module turned off loses its tab.
    /// Notes and More are always there.
    @State private var local = LocalSettings.shared
    /// Reminder notification taps (TP053), handed over by the app delegate.
    private let reminderTaps = ReminderTaps.shared

    var body: some View {
        TabView(selection: $router.selectedTab) {
            Tab("Notes", systemImage: "doc.text", value: VaultTab.notes) {
                notes()
            }
            if local.isOn(.inbox) {
                Tab(InboxCopy.title, systemImage: "tray", value: VaultTab.inbox) {
                    InboxTab(store: inboxStore)
                }
            }
            if local.isOn(.tasks) {
                Tab("Tasks", systemImage: "checkmark.circle", value: VaultTab.tasks) {
                    tasks()
                }
            }
            if local.isOn(.journal) {
                Tab("Journal", systemImage: "book", value: VaultTab.journal) {
                    ComingSoonTab(
                        title: "Journal",
                        detail: "The journal is on your computer for now. Journal entries sync and can be read as notes."
                    )
                }
            }
            Tab("More", systemImage: "ellipsis", value: VaultTab.more) {
                more()
            }
        }
        .environment(router)
        .environment(inboxRouter)
        // A tapped inbox notification or a Share hand-off opens the Inbox.
        .onChange(of: inboxLinks.pending, initial: true) {
            if inboxLinks.take() { inboxRouter.openInbox(in: router) }
        }
        // A tapped reminder opens its task; a tap from a cold start waits in
        // `ReminderTaps` until this shell exists, hence `initial: true`.
        .onChange(of: reminderTaps.pending, initial: true) {
            reminderTaps.take()?.open(in: router)
        }
        // The vault closed or the account signed out: no reminder text may
        // outlive it on the lock screen. The next vault refills its own window.
        .onDisappear {
            Task {
                await ReminderScheduler.shared.clearAll()
                await InboxNotifications.clearAll()
            }
        }
        // Turning a module off stops its reminders on this phone (flow lane 06).
        .onChange(of: local.isOn(.tasks)) { _, on in
            if !on { Task { await ReminderScheduler.shared.clearAll() } }
        }
        .onChange(of: local.isOn(.inbox)) { _, on in
            if !on { Task { await InboxNotifications.clearAll() } }
        }
        // Sign out lives on Settings › Account (F1), so the shell stops
        // drawing it over every screen of the vault.
        .preference(key: SignOutHostedKey.self, value: true)
    }
}

/// A tab that exists in the product and not yet on this phone.
///
/// It names the feature, says where it works today, and stops. No date, no
/// waitlist, no button: `DESIGN.md` rejects promising a mechanism the build
/// does not have.
private struct ComingSoonTab: View {
    let title: String
    let detail: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(title, systemImage: "hourglass")
            } description: {
                Text(detail)
            }
            .navigationTitle(title)
            .background(Tokens.Canvas.background.color)
        }
    }
}
