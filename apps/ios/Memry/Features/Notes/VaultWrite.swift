import Foundation
import MemryCore
import Observation

// The write half of the browse surface (T126's CRUD, now exported).
//
// **Separate from `NotesReading` on purpose.** A read needs a database; a write
// needs this device's identity, because every field it touches carries a vector
// clock keyed by the device that wrote it. The core derives that identity from
// the signing key in the keychain, so a writer cannot be built where a reader
// can — and folding them into one protocol would mean a browse screen that
// cannot open when the keychain is locked.
//
// **Every write blocks and then reloads.** The core call is a local SQLite
// commit, so it goes on the same serial `CoreExecutor` as the reads. The
// reload afterwards is two FFI crossings rather than a patched-in-place
// outline: the projection the core writes is the truth about what a write did,
// and a screen that edited its own copy would be guessing at it.
//
// **Nothing is shown before it is durable.** The core returns only after
// `COMMIT`, so a create that throws leaves no row and nothing to undo. The
// screen shows the note after the call answers, never before.

/// One vault's write surface.
protocol NotesWriting: Sendable {
    /// Creates an empty note and returns the id the core minted.
    ///
    /// The id is the core's because a note id is also its CRDT document id: a
    /// shell-minted one could fail the document-id shape and produce a note
    /// whose body can never be pushed.
    func create(title: String, folderPath: String?) async throws -> String
    func rename(id: String, title: String) async throws
    /// `nil` is the vault root, and it travels as an explicit null rather than
    /// an absent key — otherwise every other device keeps the old folder.
    func move(id: String, folderPath: String?) async throws
    /// Tombstones the note. Not a row that vanishes: a delete has to reach the
    /// other devices, and a vanished row has nothing left to send.
    func delete(id: String) async throws
    /// Creates a note from a template and returns its id (N803).
    func createFromTemplate(templateId: String, title: String, folderPath: String?) async throws
        -> String
    /// Sets a reminder on a note and returns its id (N804).
    func addReminder(noteId: String, remindAt: String, title: String?) async throws -> String
    func dismissReminder(id: String) async throws
    func snoozeReminder(id: String, until: String) async throws
    /// Creates a `folder_config` at `path` (N806). A path is a folder's id.
    func createFolder(path: String) async throws
    /// Sets a folder's icon, or clears it with `nil`. A folder that only exists
    /// because a note names it gets its `folder_config` created.
    func setFolderIcon(path: String, icon: String?) async throws
    /// Renames a folder in place; its notes and subfolders follow the path.
    func renameFolder(path: String, newName: String) async throws
    /// Moves a folder under `newParent`, or to the vault root with `nil`.
    func moveFolder(path: String, newParent: String?) async throws
    /// Tombstones a folder's configs. The core refuses a subtree that still
    /// holds a live note, so the notes go first.
    func deleteFolder(path: String) async throws
    /// Copies a note beside itself (icon, cover, tags, properties, body) and
    /// returns the copy's id; `nil` when the source is gone.
    func duplicate(id: String, title: String) async throws -> String?
    /// Whether the item is in the sidebar's bookmarks, desktop's favorites.
    /// `itemType` is `note` or `journal`.
    func isBookmarked(itemType: String, itemId: String) async throws -> Bool
    /// Adds or removes the item's bookmark; answers the new state.
    func toggleBookmark(itemType: String, itemId: String) async throws -> Bool
}

/// The production writer: the core's own `NotesWriter`, over the shell's one
/// serial core queue.
struct CoreNotesWriter: NotesWriting {
    private let vault: Vault
    private let store: any SecureStore
    private let executor: CoreExecutor

    init(vault: Vault, store: any SecureStore, executor: CoreExecutor) {
        self.vault = vault
        self.store = store
        self.executor = executor
    }

    /// Minted per write rather than held.
    ///
    /// It costs one keychain read and one hash, and it keeps the failure where
    /// the user can see it: a keychain that is locked when the write happens
    /// is what matters, not whether it was locked when the screen opened. A
    /// writer cached at init would have had to fail the whole browse screen.
    private func writer() throws -> NotesWriter {
        try vault.notesWriter(store: store)
    }

    func create(title: String, folderPath: String?) async throws -> String {
        try await executor.run {
            let writer = try writer()
            let id = try writer.create(title: title, folderPath: folderPath)
            // A new note opens on one empty paragraph, as desktop's does, so
            // the page shows an editor rather than the "text is not on this
            // phone" state a body-less note reads as. The note already
            // exists, so a failed seed is logged rather than thrown.
            do {
                _ = try writer.editBlock(
                    noteId: id,
                    edit: .insertParagraph(
                        afterBlockId: nil, text: "", newBlockId: UUID().uuidString.lowercased()
                    )
                )
            } catch {
                Log.storage.error("a new note's first paragraph did not land")
            }
            return id
        }
    }

    func rename(id: String, title: String) async throws {
        try await executor.run { try writer().rename(id: id, title: title) }
    }

    func move(id: String, folderPath: String?) async throws {
        try await executor.run { try writer().moveToFolder(id: id, folderPath: folderPath) }
    }

    func delete(id: String) async throws {
        try await executor.run { try writer().delete(id: id) }
    }

    func createFromTemplate(templateId: String, title: String, folderPath: String?) async throws
        -> String
    {
        try await executor.run {
            try writer().createFromTemplate(
                templateId: templateId, title: title, folderPath: folderPath
            )
        }
    }

    func addReminder(noteId: String, remindAt: String, title: String?) async throws -> String {
        try await executor.run {
            try writer().addReminder(noteId: noteId, remindAt: remindAt, title: title)
        }
    }

    func dismissReminder(id: String) async throws {
        try await executor.run { try writer().dismissReminder(id: id) }
    }

    func snoozeReminder(id: String, until: String) async throws {
        try await executor.run { try writer().snoozeReminder(id: id, until: until) }
    }

    func createFolder(path: String) async throws {
        try await executor.run { try writer().createFolder(path: path, icon: nil) }
    }

    func setFolderIcon(path: String, icon: String?) async throws {
        try await executor.run { try writer().setFolderIcon(path: path, icon: icon) }
    }

    func renameFolder(path: String, newName: String) async throws {
        _ = try await executor.run { try writer().renameFolder(path: path, newName: newName) }
    }

    func moveFolder(path: String, newParent: String?) async throws {
        _ = try await executor.run { try writer().moveFolder(path: path, newParent: newParent) }
    }

    func deleteFolder(path: String) async throws {
        _ = try await executor.run { try writer().deleteFolder(path: path) }
    }

    func duplicate(id: String, title: String) async throws -> String? {
        try await executor.run { try writer().duplicate(sourceId: id, title: title) }
    }

    func isBookmarked(itemType: String, itemId: String) async throws -> Bool {
        try await executor.run { try vault.notes().isBookmarked(itemType: itemType, itemId: itemId) }
    }

    func toggleBookmark(itemType: String, itemId: String) async throws -> Bool {
        try await executor.run { try writer().toggleBookmark(itemType: itemType, itemId: itemId) }
    }
}

extension VaultBrowseViewModel {
    /// Creates a note in `folderPath` and returns its id, or `nil` when the
    /// write failed.
    ///
    /// The caller gets the id so it can open what it just made. `nil` is the
    /// failure, and the failure is on screen in ``writeFailure`` rather than
    /// swallowed: a create that silently did nothing is a note the user
    /// believes they wrote.
    @discardableResult
    func createNote(in folderPath: String?, title: String = "") async -> String? {
        guard let writer else { return nil }
        // Spec 006 ST41: a note made with no folder goes to Settings ›
        // General › New notes go to (device-local; `nil` is the vault root).
        let folderPath = folderPath ?? LocalSettings.shared.newNotesFolder
        do {
            let id = try await writer.create(title: title, folderPath: folderPath)
            Log.storage.info("created a note", .count(1))
            await reload()
            return id
        } catch {
            report(error, "a note could not be created")
            return nil
        }
    }

    func renameNote(id: String, to title: String) async {
        guard let writer else { return }
        do {
            try await writer.rename(id: id, title: title)
            await reload()
        } catch {
            report(error, "a note could not be renamed")
        }
    }

    func moveNote(id: String, to folderPath: String?) async {
        guard let writer else { return }
        do {
            try await writer.move(id: id, folderPath: folderPath)
            await reload()
        } catch {
            report(error, "a note could not be moved")
        }
    }

    func deleteNote(id: String) async {
        guard let writer else { return }
        do {
            try await writer.delete(id: id)
            await reload()
        } catch {
            report(error, "a note could not be deleted")
        }
    }

    /// Sets or clears a note's icon from its row (desktop's "Set icon" and
    /// "Remove icon"). `nil` clears.
    func setNoteIcon(id: String, to icon: String?) async {
        guard let metadataWriter else { return }
        do {
            try await metadataWriter.setIcon(id: id, icon: icon)
            await reload()
        } catch {
            report(error, "a note icon could not be set")
        }
    }

    /// A note's plain text for "Share a copy", pulling the body first when
    /// this device does not hold it yet, so a note outside the first sync's
    /// window is not shared as an empty file.
    func exportNote(id: String) async -> NoteExport? {
        do {
            guard var detail = try await reader.read(id: id) else { return nil }
            if !detail.body.present, let filler {
                _ = try await filler.fetchNoteBody(noteId: id)
                detail = try await reader.read(id: id) ?? detail
            }
            return NoteExport(title: detail.summary.title, text: detail.body.text)
        } catch {
            report(error, "a note could not be read for sharing")
            return nil
        }
    }

    /// Creates a folder named `name` under `parent`, or at the vault root.
    @discardableResult
    func createFolder(named name: String, in parent: String?) async -> String? {
        guard let writer else { return nil }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let path = parent.map { "\($0)/\(name)" } ?? name
        do {
            try await writer.createFolder(path: path)
            await reload()
            return path
        } catch {
            report(error, "a folder could not be created")
            return nil
        }
    }

    /// Sets or clears a folder's icon from its row. `nil` clears.
    func setFolderIcon(path: String, to icon: String?) async {
        guard let writer else { return }
        do {
            try await writer.setFolderIcon(path: path, icon: icon)
            await reload()
        } catch {
            report(error, "a folder icon could not be set")
        }
    }

    func renameFolder(path: String, to name: String) async {
        guard let writer else { return }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != path.split(separator: "/").last.map(String.init) else { return }
        do {
            try await writer.renameFolder(path: path, newName: name)
            await reload()
        } catch {
            report(error, "a folder could not be renamed")
        }
    }

    func moveFolder(path: String, to parent: String?) async {
        guard let writer else { return }
        do {
            try await writer.moveFolder(path: path, newParent: parent)
            await reload()
        } catch {
            report(error, "a folder could not be moved")
        }
    }

    /// Deletes a folder with everything in it, as desktop's folder delete does.
    ///
    /// The core refuses to cascade, so the notes are tombstoned here first,
    /// one by one, and the configs after. A folder that only exists because a
    /// note named it has no config to delete, and asking the core to delete
    /// one would fail after the notes were already gone.
    func deleteFolder(path: String) async {
        guard let writer, let outline, let node = outline.node(at: path) else { return }
        do {
            for note in node.subtreeNotes {
                try await writer.delete(id: note.id)
            }
            if outline.hasConfiguredFolder(within: path) {
                try await writer.deleteFolder(path: path)
            }
            Log.storage.info("deleted a folder", .count(node.subtreeNotes.count))
            await reload()
        } catch {
            report(error, "a folder could not be deleted")
            // Some notes may already be gone; show what is true now.
            await reload()
        }
    }

    /// A failed write says what failed and what to do next, and the outline
    /// stays as it was — the vault is still readable, only the write did not
    /// happen, so replacing the screen with an error would be a lie about the
    /// content.
    private func report(_ error: some Error, _ what: StaticString) {
        let mapped = ErrorMapping.userFacing(error)
        Log.storage.error(what, .code(mapped.code))
        writeFailure = mapped
    }
}
