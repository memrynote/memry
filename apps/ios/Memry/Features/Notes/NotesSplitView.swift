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
// **The rails (#4347, D9, #4380).** The note inspector shows only when the
// page holds the note column and the rail (`SideRails`, which also seats the
// Day Panel). Adding the list would push the note under the reading measure on
// every iPad, so while either rail is open beside a note the note stands
// alone, and the list comes back when it closes.

struct NotesSplitView: View {
    let model: VaultBrowseViewModel
    @Bindable var router: NotesSplitRouter
    @Binding var sort: BrowseSort

    @State private var columns: NavigationSplitViewVisibility = .doubleColumn
    @State private var holdsThreeColumns = false
    /// The width's columns last set, so a reappearance sets none.
    @State private var appliedColumns: ColumnsKey?
    /// 13" landscape is 1366-1376pt wide. Every smaller iPad in landscape
    /// (at most 1210pt), 13" portrait (1024-1032pt) and 13" landscape beside
    /// the page sidebar (about 1086pt) stay below it.
    private static let threeColumnWidth: CGFloat = 1300
    @State private var expanded: Set<String> = []
    @Environment(SideRails.self) private var rails: SideRails?
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
        // One owner for the columns, set at once and again when the layout
        // settles: after a width change (a rotation, the page sidebar
        // sliding in) the split view writes its own choice over the binding
        // about 70ms later, which would leave the list beside the rail.
        // Keyed on the width as well: with the rail open the page sidebar
        // sliding in leaves `widthColumns` at `.detailOnly` but still
        // triggers that write.
        .task(id: ColumnsKey(columns: widthColumns, holdsThreeColumns: holdsThreeColumns)) {
            // The task runs again each time the page reappears (another
            // page and back): only a new key sets the columns, so the one
            // the user showed stays (#4380).
            let key = ColumnsKey(columns: widthColumns, holdsThreeColumns: holdsThreeColumns)
            guard key != appliedColumns else { return }
            appliedColumns = key
            columns = widthColumns
            guard (try? await Task.sleep(for: .milliseconds(400))) != nil else { return }
            columns = widthColumns
        }
        .environment(\.noteInspectorFits, rails?.inspectorFits ?? false)
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

    /// A rail beside the open note: the note inspector or the Day Panel.
    private var railShown: Bool {
        router.current != nil && (rails?.inspectorShown == true || rails?.dayPanelShown(on: .notes) == true)
    }

    private var widthColumns: NavigationSplitViewVisibility {
        if railShown { return .detailOnly }
        return holdsThreeColumns ? .all : .doubleColumn
    }

    private struct ColumnsKey: Equatable {
        let columns: NavigationSplitViewVisibility
        let holdsThreeColumns: Bool
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
                .frame(maxWidth: .infinity, alignment: .leading)
                .modifier(NoteFolderDropTarget(folder: nil, model: model))
                .tag(NotesScope.root)
                .accessibilityIdentifier("notes.sidebar.root")
            if let roots = model.outline?.roots, !roots.isEmpty {
                Section("Collections") {
                    OutlineGroup(roots, children: \.sidebarChildren) { node in
                        FolderSidebarLabel(node: node)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .modifier(NoteFolderDropTarget(folder: node.folder.path, model: model))
                            .accessibilityIdentifier("notes.sidebar.folder.\(node.folder.path)")
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
        .toolbar { DayPanelToolbarItem() }
    }
}
