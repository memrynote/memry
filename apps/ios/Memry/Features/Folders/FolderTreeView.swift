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
    let openNote: (String) -> Void

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
        let rows = node.subtreeRows
        if rows.isEmpty, node.notes.isEmpty {
            // The folder exists and holds nothing. Distinct from a vault with
            // no notes, and distinct from a read that failed.
            ContentUnavailableView {
                Label("This folder is empty", systemImage: "tray")
            } description: {
                Text("It holds no notes and no folders on this device.")
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Space.section) {
                    if !rows.isEmpty {
                        BrowseSection(title: "Folders") { FolderTreeView(rows: rows) }
                    }
                    if !node.notes.isEmpty {
                        FolderNotesView(notes: node.notes, sort: sort, grouping: grouping)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Tokens.Space.screenInline)
                .padding(.vertical, Tokens.Space.screenBlock)
            }
        }
    }
}

/// A folder's own notes. The navigation title already names the folder, so
/// ungrouped notes carry no header; grouped ones carry their date bucket.
private struct FolderNotesView: View {
    let notes: [NoteSummary]
    let sort: BrowseSort
    let grouping: FolderNoteGrouping

    var body: some View {
        switch grouping {
        case .none:
            NoteRowsView(notes: sort.sorted(notes))
        case .date:
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                ForEach(FolderNoteGroup.group(notes, sort: sort)) { group in
                    BrowseSection(title: group.bucket.title) { NoteRowsView(notes: group.notes) }
                }
            }
        }
    }
}
