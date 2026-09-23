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
        try await executor.run { try writer().create(title: title, folderPath: folderPath) }
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
