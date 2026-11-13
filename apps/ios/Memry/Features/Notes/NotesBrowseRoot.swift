import MemryCore
import SwiftUI

// The Notes root: the vault's folder tree, its notes, Bookmarks and Tags.
// The phone stack's first screen, and the split view's list column for the
// vault root, where Bookmarks and Tags live in the sidebar instead.

/// The sort control. Lifted out of `NotesListView.body` on purpose — see the
/// toolbar comment there.
struct SortMenu: View {
    @Binding var sort: BrowseSort

    var body: some View {
        Menu {
            Section("Folders stay A \u{2192} Z under every time mode.") {
                Picker("Sort notes", selection: $sort) {
                    ForEach(BrowseSort.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
            }
        } label: {
            Label("Sort by", systemImage: "arrow.up.arrow.down")
        }
    }
}

/// The root of the stack. Every phase is a distinct render.
struct VaultBrowseScreen: View {
    let model: VaultBrowseViewModel
    @Binding var expanded: Set<String>
    @Binding var selectedFolder: String?
    let sort: BrowseSort
    let openFolder: (String) -> Void
    let openNote: (String) -> Void
    let openTag: (String) -> Void

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                // Words, never a bare spinner, and never a duration.
                ProgressView { Text("Reading this vault") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .empty:
                EmptyVaultNotice()
            case let .unreadable(error):
                VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                    ErrorNotice(error: error, code: nil)
                    Button("Try again") { Task { await model.reload() } }
                        .memrySecondaryAction()
                }
                .padding(.horizontal, Tokens.Space.screenInline)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            case let .ready(outline):
                VaultOutlineList(
                    outline: outline,
                    expanded: $expanded,
                    selectedFolder: $selectedFolder,
                    sort: sort,
                    model: model,
                    openFolder: openFolder,
                    openNote: openNote,
                    openTag: openTag
                )
            }
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
    }
}

/// The hierarchy itself, as one flat platform list.
private struct VaultOutlineList: View {
    let outline: VaultOutline
    @Binding var expanded: Set<String>
    @Binding var selectedFolder: String?
    let sort: BrowseSort
    /// Carried down for the row actions. The rows are where a rename, a move
    /// or a delete starts, and each one needs the writer behind them.
    let model: VaultBrowseViewModel
    let openFolder: (String) -> Void
    let openNote: (String) -> Void
    let openTag: (String) -> Void
    /// Folded from its title, like Bookmarks and Tags. Only foldable when
    /// those exist: alone, the tree has no title to tap.
    @AppStorage("notes.section.collections.collapsed") private var collectionsCollapsed = false
    /// Inside the split view, Bookmarks and Tags are the sidebar's.
    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?

    private var hasShortcuts: Bool { split == nil && (!model.bookmarks.isEmpty || !model.tags.isEmpty) }

    var body: some View {
        let showsTree = !hasShortcuts || !collectionsCollapsed
        let tree = outline.browseRows(expanded: expanded, sort: sort)
        let unplaced = outline.unplacedRows(sort: sort)
        NotesList(noteIds: showsTree ? (tree + unplaced).compactMap(\.noteId) : []) {
            // Named only beside the sections under it, as desktop's sidebar
            // names Collections beside Bookmarks and Tags. A vault with
            // neither keeps the tree unlabelled.
            if hasShortcuts {
                ShortcutsTitleRow(title: "Collections", isCollapsed: $collectionsCollapsed)
            }
            if showsTree {
                treeRows(tree)
            }
            if !outline.unplacedNotes.isEmpty, showsTree {
                // Kaan's spec-defect 124 decision, named on screen rather
                // than papered over. These notes are real; their folder
                // carries no `folder_config` row, so the tree above cannot
                // contain them.
                Section {
                    ForEach(unplaced) { row in
                        BrowseRowView(row: row, toggle: toggle, model: model)
                            .notesSelection(row)
                    }
                } header: {
                    Text("Outside the folder list")
                } footer: {
                    Text("These notes are in folders this vault has no folder record for.")
                }
            }
            if split == nil {
                BookmarksSection(bookmarks: model.bookmarks)
                TagsSection(tags: model.tags, openTag: openTag)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .restoresScroll("notes.root")
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .calmAnimation(.fast, value: expanded)
    }

    private func treeRows(_ rows: [BrowseRow]) -> some View {
        ForEach(rows) { row in
            BrowseRowView(
                row: row,
                toggle: toggle,
                model: model,
                selectedFolder: selectedFolder,
                openFolder: openFolder,
                openNote: openNote,
                setExpanded: setExpanded
            )
            .notesSelection(row)
        }
    }

    private func toggle(_ path: String) {
        if expanded.contains(path) { expanded.remove(path) } else { expanded.insert(path) }
        selectedFolder = path
    }

    private func setExpanded(_ paths: [String], _ isOpen: Bool) {
        if isOpen { expanded.formUnion(paths) } else { expanded.subtract(paths) }
    }
}
