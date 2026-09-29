import MemryCore
import SwiftUI
import UIKit

// The long-press menus on the browse tree's rows, after desktop's Collections
// context menus and the Paper "Row long-press" artboards (26B, 26C).
//
// **Modifiers rather than wrapper views**, so the row they decorate stays in
// the list's own hierarchy: swipe actions and context menus are list-row
// treatments, and a row wrapped in a container loses them.
//
// **Only what this device can actually do.** Desktop's menus also offer
// bookmarks, templates, "new note from note", duplicate and folder icons; the
// core exports no write for any of them, so they are absent rather than shown
// failing. Opening in a tab or in Finder has no meaning on a phone.
//
// **Delete is destructive and confirmed.** Not because a tombstone is
// unrecoverable, but because the row disappears from every device.

struct NoteRowActions: ViewModifier {
    let note: NoteSummary
    let model: VaultBrowseViewModel

    @State private var isRenaming = false
    @State private var isConfirmingDelete = false
    @State private var isPickingIcon = false
    @State private var draftTitle = ""
    @State private var sharedCopy: SharedCopy?

    func body(content: Content) -> some View {
        if model.writer == nil {
            // No identity to write under: the row is a row, and nothing on it
            // suggests otherwise.
            content
        } else {
            content
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        isConfirmingDelete = true
                    }
                }
                .contextMenu {
                    NoteRowMenu(
                        note: note,
                        model: model,
                        rename: startRenaming,
                        pickIcon: { isPickingIcon = true },
                        share: share,
                        delete: { isConfirmingDelete = true }
                    )
                }
                .alert("Rename note", isPresented: $isRenaming) {
                    TextField("Title", text: $draftTitle)
                    Button("Save") {
                        Task { await model.renameNote(id: note.id, to: draftTitle) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("An untitled note is listed by its date until it has one.")
                }
                .confirmationDialog(
                    "Delete this note?",
                    isPresented: $isConfirmingDelete,
                    titleVisibility: .visible
                ) {
                    Button("Delete", role: .destructive) {
                        Task { await model.deleteNote(id: note.id) }
                    }
                    Button("Keep", role: .cancel) {}
                } message: {
                    // What actually happens, and where it happens: the note
                    // leaves every device on the account, not just this phone.
                    Text("It leaves every device on this account. Your computer keeps no copy of it either.")
                }
                .sheet(isPresented: $isPickingIcon) {
                    EmojiPickerSheet(current: note.emoji) { chosen in
                        isPickingIcon = false
                        Task { await model.setNoteIcon(id: note.id, to: chosen) }
                    }
                }
                .sheet(item: $sharedCopy) { copy in
                    ActivityShareSheet(text: copy.export.contents)
                        .presentationDetents([.medium, .large])
                        .ignoresSafeArea()
                }
        }
    }

    private func startRenaming() {
        draftTitle = note.title
        isRenaming = true
    }

    private func share() {
        Task {
            if let export = await model.exportNote(id: note.id) {
                sharedCopy = SharedCopy(export: export)
            }
        }
    }
}

/// The note row's menu. Its own view because it iterates the folders, and
/// `NotesListView.body` must stay free of every iterating container — the
/// navigation destinations registered there depend on it.
private struct NoteRowMenu: View {
    let note: NoteSummary
    let model: VaultBrowseViewModel
    let rename: () -> Void
    let pickIcon: () -> Void
    let share: () -> Void
    let delete: () -> Void

    var body: some View {
        Section {
            Button("Rename", systemImage: "pencil") { rename() }
            if let outline = model.outline {
                MoveDestinationMenu(
                    title: "Move to folder",
                    outline: outline,
                    excluded: [],
                    current: note.folderPath
                ) { destination in
                    Task { await model.moveNote(id: note.id, to: destination) }
                }
            }
        }
        if model.metadataWriter != nil {
            Section {
                Button("Set icon", systemImage: "face.smiling") { pickIcon() }
                if let emoji = note.emoji, !emoji.isEmpty {
                    Button("Remove icon", systemImage: "xmark") {
                        Task { await model.setNoteIcon(id: note.id, to: nil) }
                    }
                }
            }
        }
        Section {
            Button("Share a copy", systemImage: "square.and.arrow.up") { share() }
        }
        Section {
            Button("Delete note", systemImage: "trash", role: .destructive) { delete() }
        }
    }
}

// MARK: - Folders

/// What a folder row's menu needs from the tree around it.
struct FolderRowContext {
    let path: String
    let title: String
    let openFolder: ((String) -> Void)?
    let openNote: ((String) -> Void)?
    /// Opens or closes a set of folders at once, for "Expand subfolders" and
    /// "Collapse subfolders".
    let setExpanded: (([String], Bool) -> Void)?
}

struct FolderRowActions: ViewModifier {
    let context: FolderRowContext
    let model: VaultBrowseViewModel

    @State private var isRenaming = false
    @State private var isNamingSubfolder = false
    @State private var isConfirmingDelete = false
    @State private var isPickingIcon = false
    @State private var draftName = ""

    private var node: FolderNode? { model.outline?.node(at: context.path) }
    private var noteCount: Int { node?.subtreeNotes.count ?? 0 }
    /// The stored icon when it is an emoji: what the picker can replace and
    /// Remove can clear. An `icon:` or `custom:` value from desktop is not one.
    private var currentIcon: String? { ProjectIconValue.emoji(node?.folder.icon) }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                FolderRowMenu(
                    context: context,
                    model: model,
                    hasSubfolders: !(node?.children.isEmpty ?? true),
                    newFolder: {
                        draftName = ""
                        isNamingSubfolder = true
                    },
                    rename: {
                        draftName = context.title
                        isRenaming = true
                    },
                    pickIcon: { isPickingIcon = true },
                    delete: { isConfirmingDelete = true }
                )
            }
            .sheet(isPresented: $isPickingIcon) {
                EmojiPickerSheet(current: currentIcon) { chosen in
                    isPickingIcon = false
                    Task { await model.setFolderIcon(path: context.path, to: chosen) }
                }
            }
            .alert("New folder", isPresented: $isNamingSubfolder) {
                TextField("Name", text: $draftName)
                Button("Create") {
                    let parent = context.path
                    let name = draftName
                    Task {
                        if await model.createFolder(named: name, in: parent) != nil {
                            context.setExpanded?([parent], true)
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Inside \(context.title).")
            }
            .alert("Rename folder", isPresented: $isRenaming) {
                TextField("Name", text: $draftName)
                Button("Save") {
                    let name = draftName
                    Task { await model.renameFolder(path: context.path, to: name) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                "Delete \(context.title)?",
                isPresented: $isConfirmingDelete,
                titleVisibility: .visible
            ) {
                Button("Delete folder", role: .destructive) {
                    Task { await model.deleteFolder(path: context.path) }
                }
                Button("Keep", role: .cancel) {}
            } message: {
                Text(deleteMessage)
            }
    }

    /// Says what goes with the folder, because desktop's delete takes the
    /// contents too and a count is the only way to see that from here.
    private var deleteMessage: String {
        switch noteCount {
        case 0: "It leaves every device on this account."
        case 1: "Its 1 note goes with it, on every device on this account."
        default: "Its \(noteCount) notes go with it, on every device on this account."
        }
    }
}

private struct FolderRowMenu: View {
    let context: FolderRowContext
    let model: VaultBrowseViewModel
    let hasSubfolders: Bool
    let newFolder: () -> Void
    let rename: () -> Void
    let pickIcon: () -> Void
    let delete: () -> Void

    /// Any stored icon, including a desktop `icon:` value, can be removed.
    private var hasIcon: Bool {
        !(model.outline?.node(at: context.path)?.folder.icon ?? "").isEmpty
    }

    private var parent: String? {
        guard let slash = context.path.lastIndex(of: "/") else { return nil }
        return String(context.path[..<slash])
    }

    var body: some View {
        if let openFolder = context.openFolder {
            Section {
                Button("Open folder", systemImage: "arrow.forward") { openFolder(context.path) }
            }
        }
        if model.writer != nil {
            Section {
                Button("New note", systemImage: "square.and.pencil") {
                    Task {
                        if let id = await model.createNote(in: context.path) {
                            context.openNote?(id)
                        }
                    }
                }
                Button("New folder", systemImage: "folder.badge.plus") { newFolder() }
            }
        }
        if hasSubfolders, let setExpanded = context.setExpanded,
           let paths = model.outline?.node(at: context.path)?.subtreePaths {
            Section {
                Button("Expand subfolders", systemImage: "chevron.down.2") { setExpanded(paths, true) }
                Button("Collapse subfolders", systemImage: "chevron.up.2") { setExpanded(paths, false) }
            }
        }
        if model.writer != nil {
            Section {
                if let outline = model.outline {
                    MoveDestinationMenu(
                        title: "Move folder to",
                        outline: outline,
                        excluded: Set(outline.node(at: context.path)?.subtreePaths ?? [context.path]),
                        current: parent
                    ) { destination in
                        Task { await model.moveFolder(path: context.path, to: destination) }
                    }
                }
                Button("Rename", systemImage: "pencil") { rename() }
            }
            Section {
                Button("Set icon", systemImage: "face.smiling") { pickIcon() }
                if hasIcon {
                    Button("Remove icon", systemImage: "xmark") {
                        Task { await model.setFolderIcon(path: context.path, to: nil) }
                    }
                }
            }
            Section {
                Button("Delete folder", systemImage: "trash", role: .destructive) { delete() }
            }
        }
    }
}

// MARK: - Shared pieces

/// A submenu of every folder something can move into, plus the vault root.
///
/// `current` is left out because moving somewhere a thing already is does
/// nothing (the core refuses a folder move to its own parent), and `excluded`
/// keeps a folder out of its own subtree.
private struct MoveDestinationMenu: View {
    let title: String
    let outline: VaultOutline
    let excluded: Set<String>
    let current: String?
    let move: (String?) -> Void

    var body: some View {
        Menu {
            if current != nil {
                // The root is a destination like any other, and it is named
                // rather than implied: moved there is the top of the vault,
                // not nowhere.
                Button("Top of the vault", systemImage: "tray") { move(nil) }
            }
            ForEach(outline.folderRows.filter { !excluded.contains($0.path) && $0.path != current }) { folder in
                Button(String(repeating: "\u{2003}", count: min(folder.depth, 4)) + folder.title) {
                    move(folder.path)
                }
            }
        } label: {
            Label(title, systemImage: "folder")
        }
    }
}

/// One copy handed to the share sheet.
private struct SharedCopy: Identifiable {
    let id = UUID()
    let export: NoteExport
}

/// The system share sheet over a note's plain text. A `ShareLink` needs its
/// item before the tap, and the text is only read once "Share a copy" is
/// chosen.
private struct ActivityShareSheet: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
