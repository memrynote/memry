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
                SearchHitRow(hit: hit)
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

/// One row of the tree, drawn as desktop's Collections tree draws it: a
/// chevron slot, an icon slot (the stored emoji, or a folder or page glyph),
/// the name, and a trailing count or arrow. A folder toggles in place and
/// becomes the selected row; the selected folder carries an arrow that opens
/// it on its own screen, the phone's stand-in for desktop's hover-only
/// "open folder view" button.
struct BrowseRowView: View {
    let row: BrowseRow
    let toggle: (String) -> Void
    let model: VaultBrowseViewModel
    var selectedFolder: String?
    var openFolder: ((String) -> Void)?
    /// Pushes a note by id, for a folder menu's "New note".
    var openNote: ((String) -> Void)?
    /// Opens or closes several folders at once, for the folder menu.
    var setExpanded: (([String], Bool) -> Void)?

    private var isSelected: Bool {
        if case let .folder(path, _, _, _, _) = row.kind { return path == selectedFolder }
        return false
    }

    var body: some View {
        content
            .listRowInsets(EdgeInsets(
                top: 0,
                leading: Tokens.Space.small,
                bottom: 0,
                trailing: Tokens.Space.small
            ))
            .listRowSeparator(.hidden)
            .listRowBackground(
                RoundedRectangle(cornerRadius: Tokens.Radius.small)
                    .fill(isSelected ? Tokens.Canvas.surface.color : .clear)
                    .padding(.horizontal, Tokens.Space.small)
            )
    }

    @ViewBuilder
    private var content: some View {
        switch row.kind {
        case let .folder(path, icon, noteCount, hasContents, isExpanded):
            HStack(spacing: 0) {
                Button { toggle(path) } label: {
                    TreeRowLabel(
                        depth: row.depth,
                        disclosure: hasContents ? isExpanded : nil,
                        emoji: ProjectIconValue.emoji(icon),
                        symbol: "folder",
                        symbolTint: Tokens.Text.secondary.color,
                        title: row.title,
                        isPlaceholderTitle: row.isPlaceholderTitle,
                        isEmphasized: isSelected
                    ) {
                        // Only where it is not already on screen: an open
                        // folder's notes are the rows underneath.
                        if !isExpanded, noteCount > 0, !isSelected {
                            Text(noteCount.formatted())
                                .font(Tokens.Typography.caption.font.monospacedDigit())
                                .foregroundStyle(Tokens.Text.tertiary.color)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(noteCount > 0 ? "\(row.title), \(noteCount) notes" : row.title)
                // Said in words rather than as a trait: `AccessibilityTraits`
                // has no expanded state.
                .accessibilityValue(hasContents ? (isExpanded ? "Expanded" : "Collapsed") : "")
                .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
                .accessibilityAction(named: "Open folder") { openFolder?(path) }
                if isSelected, let openFolder {
                    Button { openFolder(path) } label: {
                        Image(systemName: "arrow.forward")
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open folder")
                }
            }
            .contentShape(.rect)
            .modifier(FolderRowActions(
                context: FolderRowContext(
                    path: path,
                    title: row.title,
                    openFolder: openFolder,
                    openNote: openNote,
                    setExpanded: setExpanded
                ),
                model: model
            ))
        case let .note(note):
            // `NavigationLink(value:)` and not `NavigationLink(destination:)`:
            // a value push resolves against the **one** registration in
            // `NotesListView.body`, which is what lets a restored path reach
            // the same screen without a row existing.
            NavigationLink(value: NoteRoute(id: note.id)) {
                NoteRowLabel(row: row, note: note)
            }
            .navigationLinkIndicatorVisibility(.hidden)
            .modifier(NoteRowActions(note: note, model: model))
        }
    }
}

/// One note line: the note's emoji, or a page glyph, and its title.
struct NoteRowLabel: View {
    let row: BrowseRow
    let note: NoteSummary

    var body: some View {
        TreeRowLabel(
            depth: row.depth,
            disclosure: nil,
            emoji: ProjectIconValue.emoji(note.emoji),
            symbol: "doc",
            symbolTint: Tokens.Text.tertiary.color,
            title: row.title,
            isPlaceholderTitle: row.isPlaceholderTitle,
            isEmphasized: false
        ) { EmptyView() }
    }
}

/// The shared row layout, from the Paper "Notes \u{2014} List" artboard: 16pt a
/// level, a 16pt chevron slot, a 20pt icon slot and 6pt before the name.
/// `disclosure` is `nil` for a row with nothing to open, which keeps an empty
/// chevron slot so every icon in a level lines up.
struct TreeRowLabel<Trailing: View>: View {
    let depth: Int
    let disclosure: Bool?
    /// Drawn instead of `symbol` when present. `icon:` and `custom:` values
    /// from desktop are not emoji and fall back to the glyph, as a project's
    /// icon does (`ProjectIconValue`).
    let emoji: String?
    let symbol: String
    let symbolTint: Color
    let title: String
    let isPlaceholderTitle: Bool
    let isEmphasized: Bool
    @ViewBuilder let trailing: () -> Trailing

    @ScaledMetric(relativeTo: .subheadline) private var indent: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var chevronSlot: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var iconSlot: CGFloat = 20
    @ScaledMetric(relativeTo: .subheadline) private var titleGap: CGFloat = 6
    /// Past this many levels the indentation stops growing, so a deep tree
    /// does not push its names off the edge at large Dynamic Type sizes.
    private var indentLimit: Int { 6 }

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if let disclosure {
                    Image(systemName: "chevron.forward")
                        .font(Tokens.Typography.caption.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .rotationEffect(.degrees(disclosure ? 90 : 0))
                } else {
                    Color.clear
                }
            }
            .frame(width: chevronSlot)
            .accessibilityHidden(true)
            Group {
                if let emoji {
                    Text(emoji).font(Tokens.Typography.supporting.font)
                } else {
                    Image(systemName: symbol)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(symbolTint)
                }
            }
            .frame(width: iconSlot)
            .accessibilityHidden(true)
            Text(title)
                .font(Tokens.Typography.supporting.font.weight(isEmphasized ? .medium : .regular))
                .foregroundStyle(isPlaceholderTitle ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
                .lineLimit(1)
                .padding(.leading, titleGap)
            Spacer(minLength: Tokens.Space.tight)
            trailing()
        }
        .padding(.leading, Tokens.Space.small + indent * CGFloat(min(depth, indentLimit)))
        .padding(.trailing, Tokens.Space.tight)
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
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
