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

struct VaultTabsView<Notes: View>: View {
    @ViewBuilder let notes: () -> Notes

    var body: some View {
        TabView {
            Tab("Notes", systemImage: "doc.text") {
                notes()
            }
            Tab("Home", systemImage: "house") {
                ComingSoonTab(
                    title: "Home",
                    detail: "The home board with your widgets is on your computer for now."
                )
            }
            Tab("Tasks", systemImage: "checkmark.circle") {
                ComingSoonTab(
                    title: "Tasks",
                    detail: "Tasks and projects are on your computer for now. Task blocks inside a note still show here."
                )
            }
            Tab("Journal", systemImage: "book") {
                ComingSoonTab(
                    title: "Journal",
                    detail: "The journal is on your computer for now. Journal entries sync and can be read as notes."
                )
            }
            Tab("More", systemImage: "ellipsis") {
                ComingSoonTab(
                    title: "More",
                    detail: "Settings, tags, bookmarks and templates are on your computer for now."
                )
            }
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
