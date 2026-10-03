import Foundation
import MemryCore
import SwiftUI

/// One titled group.
struct BrowseSection<Content: View>: View {
    let title: String
    var caption: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(title)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            if let caption {
                Text(caption)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            content()
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The note rows. Lazy on purpose — a real vault holds thousands — which is
/// exactly why no `navigationDestination` may live in here.
struct NoteRowsView: View {
    let notes: [NoteSummary]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: Tokens.Space.tight) {
            ForEach(notes, id: \.id) { note in
                // `NavigationLink(value:)` and not `NavigationLink(destination:)`:
                // a value push resolves against the **one** registration in
                // `NotesListView.body`, which is what lets a restored path
                // reach the same screen without a row existing. A destination
                // built here would be a second, lazily-registered one.
                NavigationLink(value: NoteRoute(id: note.id)) {
                    NoteRowLabel(row: .note(note), note: note)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
