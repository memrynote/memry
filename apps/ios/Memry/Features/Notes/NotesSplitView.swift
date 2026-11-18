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
// sidebar open): the list and the note, with the tree a tap away. Set on the
// width this view gets, never the device. `NotesColumns` owns the rule,
// including which of the split view's writes are the user's: a column the
// user shows or hides stays until they toggle again or rotate.
//
// **The rails (#4347, D9, #4380).** The note inspector shows only when the
// page holds the note column and the rail (`SideRails`, which also seats the
// Day Panel). Adding the list would push the note under the reading measure on
// every iPad, so while either rail is open beside a note the note stands
// alone, and the list comes back when it closes.
//
// **Two notes (#4377).** The detail column holds a second note beside the
// first where the page holds a note and a rail (`NotesDetailColumn`). The two
// take the room the rails and the list would: while they show, the rails
// yield and the notes stand alone, as beside a rail.

struct NotesSplitView: View {
    let model: VaultBrowseViewModel
    @Bindable var router: NotesSplitRouter
    @Binding var sort: BrowseSort

    @State private var notesColumns = NotesColumns()
    @State private var expanded: Set<String> = []
    @Environment(SideRails.self) private var rails: SideRails?
    @State private var selectedFolder: String?
    private let notesLinks = NotesLinks.shared
    @Environment(\.requestVaultSync) private var requestVaultSync

    var body: some View {
        NavigationSplitView(columnVisibility: Binding(get: { notesColumns.onScreen }, set: { written in
            notesColumns.splitViewWrote(written, at: .now)
            // In its own turn: put back in this one, the state would not
            // change and the split view would keep its write.
            if notesColumns.needsPutBack { Task { notesColumns.putBack() } }
        })) {
            NotesSidebar(model: model, router: router)
        } content: {
            listColumn
        } detail: {
            NotesDetailColumn(model: model, router: router)
        }
        .navigationSplitViewStyle(.balanced)
        // The width left beside the app's page sidebar, a safe-area inset.
        // With that sidebar open the split view keeps two columns anyway.
        .onGeometryChange(for: CGSize.self) { $0.size } action: {
            notesColumns.splitViewResized(to: $0, at: .now)
        }
        .background { WindowSizeReader { notesColumns.windowResized(to: $0, at: .now) } }
        // A reappearance (another page and back) keeps the user's columns,
        // which `NotesColumns` holds (#4380).
        .onChange(of: columnInputs, initial: true) { _, inputs in notesColumns.update(inputs) }
        .environment(\.noteInspectorFits, rails?.inspectorFits ?? false)
        .environment(router)
        .onChange(of: rails?.pageRoom(on: .notes) ?? SideRailRoom.none, initial: true) { _, room in
            router.splitFits = room != .none
        }
        .onChange(of: router.splitShown, initial: true) { _, shown in rails?.notesSplit = shown }
        // ⌘\ and ⌘⌥W (`VaultCommands`).
        .focusedSceneValue(\.notesSplit, router)
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

    private var columnInputs: NotesColumns.Inputs {
        NotesColumns.Inputs(noteBesideRail: railShown || router.splitShown, rails: rails?.open, splitShown: router.splitShown)
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
