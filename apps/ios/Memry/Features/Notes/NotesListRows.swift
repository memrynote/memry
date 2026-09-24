import Foundation
import MemryCore
import SwiftUI

// The browse list's rows and search results, split from `NotesListView.swift`.

/// What a search shows.
///
/// **Three different answers, and they are not interchangeable.** The index
/// answering "nothing matched" is a fact about the query. The index failing is
/// a failure, and it falls back to matching titles in the outline already on
/// screen rather than showing an error over a vault the user can still read.
/// And a vault with no index at all — the file would not open — gets the same
/// title matching, silently, because that is what it had before search
/// existed.
struct SearchResultsSection: View {
    let query: String
    let search: VaultSearchViewModel?
    let outline: VaultOutline
    let sort: BrowseSort
    let model: VaultBrowseViewModel
    let toggle: (String) -> Void

    var body: some View {
        switch search?.phase {
        case let .results(hits) where !hits.isEmpty || !(search?.taskHits.isEmpty ?? true):
            ForEach(hits, id: \.id) { hit in
                // Pushed by value, through the one registration on the stack
                // root — the same route a browse row uses.
                NavigationLink(value: NoteRoute(id: hit.id)) {
                    SearchHitLabel(hit: hit)
                }
            }
            // TP056: the tasks the query matched, in their own section and
            // their own ranking, each opening in the Tasks tab.
            TaskSearchResults(hits: search?.taskHits ?? [])
        case .results:
            // Nothing matched. Not an empty vault, and said as its own thing.
            ContentUnavailableView.search(text: query)
                .listRowSeparator(.hidden)
        case .searching, .idle, .none:
            // Still running, or no index: the titles this screen already holds
            // are shown rather than a blank list. They are a subset of what
            // the index will answer, never a contradiction of it.
            TitleMatches(outline: outline, query: query, sort: sort, model: model, toggle: toggle)
        case .failed:
            TitleMatches(outline: outline, query: query, sort: sort, model: model, toggle: toggle)
        }
    }
}

/// The task hits of a search (TP056), after desktop's command palette: a
/// "Tasks" group whose rows open the task's detail (`openTaskId`).
struct TaskSearchResults: View {
    let hits: [SearchResult]
    /// Absent outside the vault shell; the rows then draw without an action.
    @Environment(TasksRouter.self) private var router: TasksRouter?

    var body: some View {
        if !hits.isEmpty {
            Section {
                ForEach(hits, id: \.id) { hit in
                    Button {
                        router?.openTask(hit.id)
                    } label: {
                        TaskSearchHitLabel(hit: hit)
                    }
                    .buttonStyle(.plain)
                    .disabled(router == nil)
                    .accessibilityHint(TasksCopy.openInTasks)
                    .accessibilityIdentifier("tasks.search.result")
                }
            } header: {
                Text(TasksCopy.searchTasksSection)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }
}

/// One task hit: the check mark says what kind of result it is.
struct TaskSearchHitLabel: View {
    let hit: SearchResult

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "checkmark.circle")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            Text(hit.title.isEmpty ? TasksCopy.untitledTask : hit.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.tight)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// The pre-index behaviour, kept as the fallback: titles, matched in memory.
struct TitleMatches: View {
    let outline: VaultOutline
    let query: String
    let sort: BrowseSort
    let model: VaultBrowseViewModel
    let toggle: (String) -> Void

    var body: some View {
        let hits = outline.searchRows(query: query, sort: sort)
        if hits.isEmpty {
            ContentUnavailableView.search(text: query)
                .listRowSeparator(.hidden)
        } else {
            ForEach(hits) { row in
                BrowseRowView(row: row, toggle: toggle, model: model)
            }
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row: a folder that opens in place, or a note that pushes.
struct BrowseRowView: View {
    let row: BrowseRow
    let toggle: (String) -> Void
    let model: VaultBrowseViewModel

    var body: some View {
        switch row.kind {
        case let .folder(path, noteCount, isExpanded):
            Button { toggle(path) } label: {
                FolderRowLabel(row: row, noteCount: noteCount, isExpanded: isExpanded)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            // Said in words rather than as a trait: `AccessibilityTraits` has
            // no expanded state, and a folder that does not say whether it is
            // open is a row VoiceOver users have to guess at.
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        case let .note(note):
            // `NavigationLink(value:)` and not `NavigationLink(destination:)`:
            // a value push resolves against the **one** registration in
            // `NotesListView.body`, which is what lets a restored path reach
            // the same screen without a row existing.
            NavigationLink(value: NoteRoute(id: note.id)) {
                NoteRowLabel(row: row, note: note)
            }
            .modifier(NoteRowActions(note: note, model: model))
        }
    }
}

/// A folder line: disclosure, name, and its own note count.
private struct FolderRowLabel: View {
    let row: BrowseRow
    let noteCount: Int
    let isExpanded: Bool

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "chevron.forward")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .frame(width: Tokens.Space.inset)
                .accessibilityHidden(true)
            Image(systemName: isExpanded ? "folder.fill" : "folder")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            Text(row.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(row.isPlaceholderTitle
                    ? Tokens.Text.secondary.color
                    : Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.tight)
            // Only where it is not already on screen: an open folder's notes
            // are the rows underneath, and counting them again is noise.
            if !isExpanded, noteCount > 0 {
                Text(noteCount.formatted())
                    .font(Tokens.Typography.caption.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .padding(.leading, CGFloat(row.depth) * Tokens.Space.inset)
        .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(noteCount > 0 ? "\(row.title), \(noteCount) notes" : row.title)
    }
}

/// One note line.
struct NoteRowLabel: View {
    let row: BrowseRow
    let note: NoteSummary

    /// `nil` means the payload carried no such instant, never "zero"
    /// (data-model §A.6). An absent date is rendered as nothing rather than as
    /// an epoch nobody wrote.
    private var modified: String? {
        guard let milliseconds = note.modifiedAt else { return nil }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
            .formatted(date: .abbreviated, time: .omitted)
    }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Group {
                if let emoji = note.emoji, !emoji.isEmpty {
                    Text(emoji)
                } else {
                    Image(systemName: "doc.text")
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .font(Tokens.Typography.body.font)
            .frame(width: Tokens.Space.section, alignment: .center)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(row.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(row.isPlaceholderTitle
                        ? Tokens.Text.secondary.color
                        : Tokens.Text.primary.color)
                if let modified {
                    Text(modified)
                        .font(Tokens.Typography.caption.font.monospacedDigit())
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            Spacer(minLength: Tokens.Space.tight)
        }
        .padding(.leading, CGFloat(row.depth) * Tokens.Space.inset)
        .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .multilineTextAlignment(.leading)
        .accessibilityElement(children: .combine)
    }
}

/// A vault that really holds nothing.
///
/// Not the same screen as a read that failed, and it promises no mechanism
/// this build has: there is no note creation on iOS, so it offers none
/// (`DESIGN.md` §"Error copy, in detail", spec-defect 111).
struct EmptyVaultNotice: View {
    var body: some View {
        ContentUnavailableView {
            Label("No notes in this vault", systemImage: "tray")
        } description: {
            Text("This phone holds no notes and no folders for this vault yet.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
