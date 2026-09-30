import MemryCore
import SwiftUI

// T156. The folder hierarchy, and the screen one folder pushes to.
//
// **Tokens only** (T160). No font, colour, spacing or radius literal appears
// below, and every edge is logical — SwiftUI's `.leading`/`.trailing` are
// direction-relative, so RTL is the default rather than a pass.
//
// **A hierarchy is an accessibility surface.** The tree is flattened into rows
// carrying a depth, so each row can state its own level: VoiceOver reads
// "Projects, level 2, 4 notes" rather than leaving the nesting to an
// indentation nobody can hear. Indentation is capped so a deep tree does not
// push its own titles off the inline edge at the largest Dynamic Type sizes.
//
// **Creates from the folder screen's "+"** (`NotesCreateButton`, bottom
// trailing): tap for a note, hold for a folder. Both go through the same
// `VaultBrowseViewModel` writes the tree's long-press menu uses, and the
// button is hidden when the device has no identity to write under.

/// The configured folders, parent before child.
struct FolderTreeView: View {
    let rows: [FolderRow]

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            ForEach(rows) { row in
                NavigationLink(value: FolderRoute(path: row.path)) {
                    FolderRowLabel(row: row)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One folder row.
private struct FolderRowLabel: View {
    let row: FolderRow

    /// Past this many levels the indentation stops growing. Depth is still
    /// announced, so the information is not lost — only the inset is.
    private static let indentLimit = 4

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "folder")
                .foregroundStyle(Tokens.Text.tertiary.color)
            Text(row.title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(row.isPlaceholderTitle
                    ? Tokens.Text.secondary.color
                    : Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.tight)
            Text(row.noteCount.formatted())
                .font(Tokens.Typography.caption.font.monospacedDigit())
                .foregroundStyle(Tokens.Text.tertiary.color)
            Image(systemName: "chevron.forward")
                .foregroundStyle(Tokens.Text.tertiary.color)
        }
        .padding(Tokens.Space.inset)
        .padding(.leading, Tokens.Space.inset * CGFloat(min(row.depth, Self.indentLimit)))
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .blockSurface(radius: Tokens.Radius.control)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.title)
        // The count is the value and the level is the hint, so a reader hears
        // the folder first and its position second.
        .accessibilityValue("\(row.noteCount) notes")
        .accessibilityHint("Level \(row.depth + 1). Opens this folder.")
    }
}

/// What a folder row pushes to.
///
/// Resolved from the snapshot the root screen already holds, which is what
/// makes a restored navigation path work: nothing here depends on a row having
/// been realised.
struct FolderScreen: View {
    let route: FolderRoute
    let model: VaultBrowseViewModel
    let openFolder: (String) -> Void
    let openNote: (String) -> Void

    @State private var expanded: Set<String> = []
    @State private var selectedFolder: String?

    /// Shared with the vault root, so both screens order notes the same way.
    @AppStorage("notes.browseSort") private var sort: BrowseSort = .modifiedNewest
    @AppStorage("notes.folderGrouping") private var grouping: FolderNoteGrouping = .none
    @State private var isNamingFolder = false
    @State private var draftName = ""

    var body: some View {
        Group {
            if let node = model.outline?.node(at: route.path) {
                contents(of: node)
                    .navigationTitle(node.title)
                    .toolbar { toolbar(for: node) }
                    // Tap for a note in this folder, hold for a folder inside it.
                    .overlay(alignment: .bottomTrailing) {
                        if model.writer != nil {
                            NotesCreateButton(
                                newNote: {
                                    Task {
                                        if let id = await model.createNote(in: route.path) { openNote(id) }
                                    }
                                },
                                newFolder: {
                                    draftName = ""
                                    isNamingFolder = true
                                }
                            )
                            .padding(.horizontal, Tokens.Space.inset)
                            .padding(.bottom, Tokens.Space.medium)
                        }
                    }
                    .alert("New folder", isPresented: $isNamingFolder) {
                        TextField("Name", text: $draftName)
                        Button("Create") {
                            let name = draftName
                            Task { await model.createFolder(named: name, in: route.path) }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Inside \(node.title).")
                    }
            } else if model.phase == .loading {
                // A write reloads the outline; for that moment the folder is
                // unknown, not missing.
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Not "empty". The folder is not in this vault's outline at
                // all, which is a different fact and a different sentence.
                ContentUnavailableView {
                    Label("This folder is not in this vault", systemImage: "folder.badge.questionmark")
                } description: {
                    Text("It may have been removed, or this device has no record of it.")
                }
            }
        }
        .background(Tokens.Canvas.background.color)
        .writeFailureAlert(model)
    }

    @ToolbarContentBuilder
    private func toolbar(for node: FolderNode) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            FolderViewMenu(sort: $sort, grouping: $grouping)
        }
    }

    @ViewBuilder
    private func contents(of node: FolderNode) -> some View {
        if node.children.isEmpty, node.notes.isEmpty {
            // The folder exists and holds nothing. Distinct from a vault with
            // no notes, and distinct from a read that failed.
            ContentUnavailableView {
                Label("This folder is empty", systemImage: "tray")
            } description: {
                Text("It holds no notes and no folders on this device.")
            }
        } else {
            List {
                // The same rows the vault root draws, so a folder's contents
                // read as the root does: folders toggle in place, the selected
                // one carries the arrow that opens it.
                ForEach(node.browseRows(expanded: expanded, sort: sort)) { row in
                    BrowseRowView(
                        row: row,
                        toggle: toggle,
                        model: model,
                        selectedFolder: selectedFolder,
                        openFolder: openFolder,
                        openNote: openNote,
                        setExpanded: setExpanded
                    )
                }
                switch grouping {
                case .none:
                    ForEach(sort.sorted(node.notes), id: \.id) { note in
                        BrowseRowView(row: .note(note), toggle: toggle, model: model)
                    }
                case .date:
                    ForEach(FolderNoteGroup.group(node.notes, sort: sort)) { group in
                        Section(group.bucket.title) {
                            ForEach(group.notes, id: \.id) { note in
                                BrowseRowView(row: .note(note), toggle: toggle, model: model)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
            .calmAnimation(.fast, value: expanded)
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
