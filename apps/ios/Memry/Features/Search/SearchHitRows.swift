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

/// One note or journal hit: the note's emoji and title over its folder, or
/// the journal's relative day over "Journal" (#4323), with "also: <alias>"
/// leading that line when an alias matched (#4319), then the snippet, or
/// "Similar meaning" for a hit only semantic search found (#4505).
struct SearchHitLabel: View {
    let hit: SearchResult

    var body: some View {
        let text = SearchRowText(hit: hit)
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(text.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1)
            if text.also != nil || text.caption != nil {
                HStack(spacing: Tokens.Space.small) {
                    if let also = text.also {
                        caption(also).layoutPriority(1)
                    }
                    switch text.caption {
                    case .folder(let path):
                        ViewThatFits(in: .horizontal) {
                            ForEach(SearchFolderPath.candidates(path), id: \.self) { candidate in
                                caption(candidate).truncationMode(.head)
                            }
                        }
                    case .journal:
                        caption("Journal")
                    case nil:
                        EmptyView()
                    }
                }
            }
            if let related = text.related {
                caption(related)
            } else {
                SearchSnippetText(segments: hit.snippet)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text.accessibilityLabel)
    }

    private func caption(_ line: String) -> some View {
        Text(line)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .lineLimit(1)
    }
}

/// One task hit: the check mark says what kind of result it is.
struct TaskSearchHitLabel: View {
    let hit: SearchResult

    var body: some View {
        let text = SearchRowText(hit: hit)
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: "checkmark.circle")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(text.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                SearchSnippetText(segments: hit.snippet)
            }
            Spacer(minLength: Tokens.Space.tight)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text.accessibilityLabel)
    }
}
