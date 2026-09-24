import MemryCore
import SwiftUI

// The shell an opened vault lives in: the five tabs the product has, with the
// four that are not built yet saying so.
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

struct VaultTabsView<Notes: View, Tasks: View>: View {
    @ViewBuilder let notes: () -> Notes
    /// The Tasks tab (spec 004 TP031), built by the caller that holds the
    /// vault, keychain and sync.
    @ViewBuilder let tasks: () -> Tasks
    /// Cross-tab navigation: search, note task blocks and reminder taps open a
    /// task through it.
    @State private var router = TasksRouter()

    var body: some View {
        TabView(selection: $router.selectedTab) {
            Tab("Notes", systemImage: "doc.text", value: VaultTab.notes) {
                notes()
            }
            Tab("Home", systemImage: "house", value: VaultTab.home) {
                ComingSoonTab(
                    title: "Home",
                    detail: "The home board with your widgets is on your computer for now."
                )
            }
            Tab("Tasks", systemImage: "checkmark.circle", value: VaultTab.tasks) {
                tasks()
            }
            Tab("Journal", systemImage: "book", value: VaultTab.journal) {
                ComingSoonTab(
                    title: "Journal",
                    detail: "The journal is on your computer for now. Journal entries sync and can be read as notes."
                )
            }
            Tab("More", systemImage: "ellipsis", value: VaultTab.more) {
                MoreTab()
            }
        }
        .environment(router)
        // The More tab holds the way out, so the shell stops drawing it over
        // every screen of the vault.
        .preference(key: SignOutHostedKey.self, value: true)
    }
}

/// The account's own page inside a vault: what is not on the phone yet, and
/// the way out.
private struct MoreTab: View {
    @Environment(AccountViewModel.self) private var account: AccountViewModel?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ContentUnavailableView {
                    Label("More", systemImage: "hourglass")
                } description: {
                    Text("Settings, tags, bookmarks and templates are on your computer for now.")
                }
                if let account {
                    SignOutBar(model: account)
                }
            }
            .navigationTitle("More")
            .background(Tokens.Canvas.background.color)
        }
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
