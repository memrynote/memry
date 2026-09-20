import MemryCore
import SwiftUI

// Rename, move and delete, on the row they act on.
//
// **A modifier rather than a wrapper view**, so the row it decorates stays a
// `NavigationLink` in the list's own hierarchy: swipe actions and context menus
// are list-row treatments, and a row wrapped in a container loses them.
//
// **Delete is destructive and confirmed.** Not because a tombstone is
// unrecoverable — it travels to the other devices and desktop still holds the
// note — but because the swipe that starts it is one gesture away from the
// swipe that scrolls, and the row disappears from every device.
//
// **The move menu lists only folders this vault has a record for.** The same
// rule the tree follows (spec-defect 124): a folder the outline cannot name is
// a folder this screen cannot put a note into honestly.

struct NoteRowActions: ViewModifier {
    let note: NoteSummary
    let model: VaultBrowseViewModel

    @State private var isRenaming = false
    @State private var isConfirmingDelete = false
    @State private var draftTitle = ""

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
                .contextMenu { RowMenu(note: note, model: model, rename: startRenaming) }
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
        }
    }

    private func startRenaming() {
        draftTitle = note.title
        isRenaming = true
    }
}

/// The row's menu. Its own view because it iterates the folders, and
/// `NotesListView.body` must stay free of every iterating container — the
/// navigation destinations registered there depend on it.
private struct RowMenu: View {
    let note: NoteSummary
    let model: VaultBrowseViewModel
    let rename: () -> Void

    var body: some View {
        Button("Rename", systemImage: "pencil") { rename() }
        if let outline = model.outline {
            Menu {
                // The root is a destination like any other, and it is named
                // rather than implied: a note moved there is at the top of the
                // vault, not nowhere.
                Button("Top of the vault") {
                    Task { await model.moveNote(id: note.id, to: nil) }
                }
                ForEach(outline.folderRows, id: \.path) { folder in
                    Button(folder.title) {
                        Task { await model.moveNote(id: note.id, to: folder.path) }
                    }
                }
            } label: {
                Label("Move to", systemImage: "folder")
            }
        }
    }
}
