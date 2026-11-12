import Foundation
import MemryCore
import SwiftUI

// The note, journal and task search hit rows, split from `NotesListRows.swift`.

/// One note or journal hit. A note is pushed by value, through the one
/// registration on the stack root — the same route a browse row uses. A
/// journal hit opens its day in the Journal tab (JP052).
struct SearchHitRow: View {
    let hit: SearchResult

    @Environment(\.openJournalDay) private var openJournalDay

    var body: some View {
        if hit.kind == "journal",
           let date = hit.journalDate.flatMap(JournalLink.date(fromWikiTarget:)),
           let openJournalDay {
            Button {
                Telemetry.shared.track(.searchResultOpened, surface: .search, action: "opened", objectType: "journal")
                openJournalDay(date)
            } label: {
                SearchHitLabel(hit: hit)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint(JournalCopy.openInJournal)
            .accessibilityIdentifier("notes.search.journal.\(date)")
        } else {
            NavigationLink(value: NoteRoute(id: hit.id)) {
                SearchHitLabel(hit: hit)
            }
            .simultaneousGesture(TapGesture().onEnded {
                Telemetry.shared.track(.searchResultOpened, surface: .search, action: "opened", objectType: "note")
            })
        }
    }
}

/// One hit. The kind is named because a journal has no title of its own — its
/// calendar date is what names it.
struct SearchHitLabel: View {
    let hit: SearchResult

    private var title: String {
        if let date = hit.journalDate, !date.isEmpty { return date }
        return hit.title.isEmpty ? "Untitled note" : hit.title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            if hit.kind == "journal" {
                Text("Journal")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            SearchSnippetText(segments: hit.snippet)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One task hit: the check mark says what kind of result it is.
struct TaskSearchHitLabel: View {
    let hit: SearchResult

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: "checkmark.circle")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(hit.title.isEmpty ? TasksCopy.untitledTask : hit.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                SearchSnippetText(segments: hit.snippet)
            }
            Spacer(minLength: Tokens.Space.tight)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
