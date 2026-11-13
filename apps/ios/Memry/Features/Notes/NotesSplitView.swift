import MemryCore
import SwiftUI

// #4346. Notes at regular width: the folder tree with Bookmarks and Tags as the
// sidebar, the folder's notes as the list, the note as the detail
// (`DESIGN.md` › Tablet). Compact width keeps the phone stack in
// `NotesListView`.
//
// **One owner.** `NotesSplitRouter` holds the list's scope and the selected
// note. The sidebar and the lists write it (a row's `NavigationLink(value:)`
// sets the list selection through `NotesList`, a bookmark or tag goes through
// `NotesLink`), and the detail column reads it. A link inside the note pushes
// onto the detail column's own stack, so Back returns to the note before.
//
// **Columns (Q4, `DESIGN.md` › Tablet).** Three at 13" landscape width with
// the page sidebar hidden, two below it (portrait, smaller iPads, the page
// sidebar open): the list and the note, with the tree a tap away. Set on the width this view gets, never the device, and again only
// when that width crosses the line, so a column the user shows or hides stays
// as they left it.
//
// **The note inspector (#4347, D9).** It shows only when this width holds the
// note column and the rail. Adding the list would push the note under the
// reading measure on every iPad, so while it is open the note stands alone,
// and the list comes back when it closes.

struct NotesSplitView: View {
    let model: VaultBrowseViewModel
    @Bindable var router: NotesSplitRouter
    @Binding var sort: BrowseSort

    @State private var columns: NavigationSplitViewVisibility = .doubleColumn
    @State private var holdsThreeColumns = false
    /// 13" landscape is 1366-1376pt wide. Every smaller iPad in landscape
    /// (at most 1210pt), 13" portrait (1024-1032pt) and 13" landscape beside
    /// the page sidebar (about 1090pt) stay below it.
    private static let threeColumnWidth: CGFloat = 1300
    @State private var expanded: Set<String> = []
    @State private var inspectorFits = false
    @AppStorage(NoteInspectorLayout.openKey) private var inspectorOpen = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var selectedFolder: String?
    private let notesLinks = NotesLinks.shared
    @Environment(\.requestVaultSync) private var requestVaultSync

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            NotesSidebar(model: model, router: router)
        } content: {
            listColumn
        } detail: {
            NotesDetailColumn(model: model, router: router)
        }
        .navigationSplitViewStyle(.balanced)
        // The width left beside the app's page sidebar, a safe-area inset.
        // With that sidebar open the split view keeps two columns anyway.
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.threeColumnWidth } action: {
            holdsThreeColumns = $0
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= NoteInspectorLayout.minimumWidth } action: {
            inspectorFits = $0
        }
        // Once the layout settles. While the page sidebar slides in, the
        // split view writes its own choice (all three columns) over the
        // binding, about 70ms after the width changes.
        .task(id: holdsThreeColumns) {
            guard (try? await Task.sleep(for: .milliseconds(400))) != nil else { return }
            columns = widthColumns
        }
        .onChange(of: inspectorShown) { columns = widthColumns }
        .environment(\.noteInspectorFits, railFits)
        .environment(router)
        // A search hit or a capture's "View": the note in the detail column,
        // its row selected in the list.
        .onChange(of: notesLinks.pending, initial: true) {
            if let id = notesLinks.take() { router.reveal(id, in: model.outline) }
        }
        .onChange(of: model.phase, initial: true) { _, phase in
            switch phase {
            case let .ready(outline): router.prune(keeping: Set(outline.allNotes.map(\.id)))
            case .empty: router.prune(keeping: [])
            case .loading, .unreadable: break
            }
        }
        .task { await model.loadIfNeeded() }
        .onChange(of: requestVaultSync == nil, initial: true) {
            model.requestSync = requestVaultSync
        }
        .onAppear { Task { await model.refresh() } }
        .writeFailureAlert(model)
    }

    /// The inspector fits beside the note: Journal's rail rule, accessibility
    /// text sizes keep the page's own sections.
    private var railFits: Bool { inspectorFits && !typeSize.isAccessibilitySize }

    private var inspectorShown: Bool { railFits && inspectorOpen && router.current != nil }

    private var widthColumns: NavigationSplitViewVisibility {
        if inspectorShown { return .detailOnly }
        return holdsThreeColumns ? .all : .doubleColumn
    }

    private func open(_ id: String) { router.select(NoteRoute(id: id)) }

    @ViewBuilder private var listColumn: some View {
        switch router.scope {
        case .root:
            VaultBrowseScreen(
                model: model,
                expanded: $expanded,
                selectedFolder: $selectedFolder,
                sort: sort,
                openFolder: { router.show(.folder($0)) },
                openNote: open,
                openTag: { router.show(.tag($0)) }
            )
            .navigationTitle(VaultTab.notes.title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { SortMenu(sort: $sort) }
            }
            .notesCreate(model, in: nil, place: "At the top of this vault.", open: open)
        case let .folder(path):
            FolderScreen(
                route: FolderRoute(path: path),
                model: model,
                openFolder: { router.show(.folder($0)) },
                openNote: open
            )
            .id(path)
        case let .tag(name):
            TaggedNotesView(tag: name, browse: model, open: { router.select($0) })
                .id(name)
        case .tags:
            TagListView(browse: model)
        case .bookmarks:
            BookmarkListView(browse: model)
        }
    }
}

/// The sidebar: the vault root, the folder tree, Bookmarks and Tags.
private struct NotesSidebar: View {
    let model: VaultBrowseViewModel
    let router: NotesSplitRouter

    var body: some View {
        List(selection: Binding(get: { router.scope }, set: { if let scope = $0 { router.show(scope) } })) {
            Label(VaultTab.notes.title, systemImage: VaultTab.notes.symbol)
                .tag(NotesScope.root)
                .accessibilityIdentifier("notes.sidebar.root")
            if let roots = model.outline?.roots, !roots.isEmpty {
                Section("Collections") {
                    OutlineGroup(roots, children: \.sidebarChildren) { node in
                        FolderSidebarLabel(node: node)
                            .tag(NotesScope.folder(node.folder.path))
                    }
                }
            }
            BookmarksSection(bookmarks: model.bookmarks)
            TagsSection(tags: model.tags, openTag: { router.show(.tag($0)) })
        }
        .listStyle(.sidebar)
        .navigationTitle(VaultTab.notes.title)
    }
}

private struct FolderSidebarLabel: View {
    let node: FolderNode

    var body: some View {
        Label {
            Text(node.title)
                .foregroundStyle(node.isPlaceholderTitle ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
        } icon: {
            if let emoji = ProjectIconValue.emoji(node.folder.icon) {
                Text(emoji)
            } else {
                Image(systemName: "folder")
            }
        }
    }
}

private extension FolderNode {
    /// `nil` for a leaf, so the tree draws no disclosure arrow on it.
    var sidebarChildren: [FolderNode]? { children.isEmpty ? nil : children }
}

/// The note, with the notes opened from inside it stacked behind it, or the
/// empty state when no note is open (D6).
private struct NotesDetailColumn: View {
    let model: VaultBrowseViewModel
    @Bindable var router: NotesSplitRouter
    @Environment(\.requestVaultSync) private var requestVaultSync
    /// Built once: a new closure on every render would change the
    /// environment of the open note and redraw its page while it is typed in.
    @State private var afterWrite: (@MainActor () -> Void)?
    /// Handed to each page: a page pushed onto the stack does not see an
    /// environment set outside it.
    @Environment(\.noteInspectorFits) private var inspectorFits

    var body: some View {
        NavigationStack(path: $router.trail) {
            Group {
                if let note = router.note {
                    reader(note).id(note)
                } else {
                    NotesEmptyDetail(model: model, router: router)
                }
            }
            .navigationDestination(for: NoteRoute.self) { reader($0) }
        }
        // Every write in the note asks for a sync pass. The list stays on
        // screen beside it, so it re-reads too: a new title or a move shows
        // in its row at once, where the phone stack re-reads on Back.
        .environment(\.requestVaultSync, afterWrite)
        .onChange(of: requestVaultSync == nil, initial: true) {
            let upstream = requestVaultSync
            afterWrite = { [model] in
                upstream?()
                Task { await model.refresh() }
            }
        }
    }

    private func reader(_ route: NoteRoute) -> some View {
        NoteReadView(
            route: route,
            reader: model.reader,
            filler: model.filler,
            editor: model.editor,
            metadataWriter: model.metadataWriter,
            writer: model.writer,
            search: model.searcher,
            open: { router.follow($0) },
            openTag: { router.show(.tag($0)) },
            noteTasks: model.noteTasks
        )
        .environment(\.noteInspectorFits, inspectorFits)
    }
}

/// No note open: what is absent and the next useful action.
private struct NotesEmptyDetail: View {
    let model: VaultBrowseViewModel
    let router: NotesSplitRouter

    private var folder: String? {
        if case let .folder(path) = router.scope { return path }
        return nil
    }

    var body: some View {
        ContentUnavailableView {
            Label("No note open", systemImage: "doc.text")
        } description: {
            Text("Choose a note from the list.")
        } actions: {
            if model.writer != nil {
                Button(NotesCreateCopy.newNote, systemImage: "square.and.pencil") {
                    Task {
                        if let id = await model.createNote(in: folder) { router.select(NoteRoute(id: id)) }
                    }
                }
                .memryPrimaryAction()
                .accessibilityIdentifier("notes.empty.newNote")
            }
        }
        .background(Tokens.Canvas.background.color)
    }
}
