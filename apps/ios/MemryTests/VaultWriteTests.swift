import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// The browse screen's writes (Phase 3, T126's CRUD once it reached the FFI).
//
// What these pin is the part a Rust test cannot see: what the **screen** does
// after the core answers. A write that succeeds and leaves the list showing the
// old outline is the same bug to a user as a write that failed.

@MainActor
@Suite("Vault writes")
struct VaultWriteTests {
    /// A writer that records what it was asked and answers as scripted.
    private final class ScriptedWriter: NotesWriting, @unchecked Sendable {
        enum Call: Equatable {
            case create(String?)
            case rename(String, String)
            case move(String, String?)
            case delete(String)
            case createFolder(String)
            case renameFolder(String, String)
            case setFolderIcon(String, String?)
            case moveFolder(String, String?)
            case deleteFolder(String)
        }

        let calls = Mutex([Call]())
        private let failure: (any Error)?

        init(failure: (any Error)? = nil) {
            self.failure = failure
        }

        private func record(_ call: Call) throws {
            calls.withLock { $0.append(call) }
            if let failure { throw failure }
        }

        func create(title: String, folderPath: String?) async throws -> String {
            try record(.create(folderPath))
            return "note-new"
        }

        func rename(id: String, title: String) async throws { try record(.rename(id, title)) }
        func move(id: String, folderPath: String?) async throws { try record(.move(id, folderPath)) }
        func delete(id: String) async throws { try record(.delete(id)) }
        func createFolder(path: String) async throws { try record(.createFolder(path)) }
        func setFolderIcon(path: String, icon: String?) async throws {
            try record(.setFolderIcon(path, icon))
        }
        func renameFolder(path: String, newName: String) async throws {
            try record(.renameFolder(path, newName))
        }
        func moveFolder(path: String, newParent: String?) async throws {
            try record(.moveFolder(path, newParent))
        }
        func deleteFolder(path: String) async throws { try record(.deleteFolder(path)) }
    }

    /// A fixed vault: `Work` has a config row, `Work/Drafts` does not, and
    /// `Loose` exists only because a note names it.
    private final class TreeReader: NotesReading, @unchecked Sendable {
        func folders() async throws -> [FolderSummary] {
            [FolderSummary(path: "Work", parentPath: nil, name: "Work", icon: nil)]
        }

        func list() async throws -> [NoteSummary] {
            [("a", "Work"), ("b", "Work/Drafts"), ("c", "Loose"), ("d", nil)].map { id, folder in
                NoteSummary(id: id, title: id, folderPath: folder, emoji: nil, createdAt: nil, modifiedAt: nil)
            }
        }

        func read(id: String) async throws -> NoteDetail? { nil }
    }

    /// A reader whose answers change between loads, so a reload is observable.
    private final class GrowingReader: NotesReading, @unchecked Sendable {
        let loads = Mutex(0)

        func folders() async throws -> [FolderSummary] { [] }

        func list() async throws -> [NoteSummary] {
            let count = loads.withLock { count -> Int in
                count += 1
                return count
            }
            return (0 ..< count).map { index in
                NoteSummary(
                    id: "note-\(index)",
                    title: "Note \(index)",
                    folderPath: nil,
                    emoji: nil,
                    createdAt: nil,
                    modifiedAt: nil
                )
            }
        }

        func read(id: String) async throws -> NoteDetail? { nil }
    }

    private func model(
        writer: ScriptedWriter?,
        reader: any NotesReading = GrowingReader()
    ) -> VaultBrowseViewModel {
        VaultBrowseViewModel(reader: reader, writer: writer)
    }

    @Test("a create returns the new note and refreshes the list")
    func createRefreshesTheList() async {
        // The core's projection is the truth about what a write did; a screen
        // that patched its own copy would be guessing at it.
        let writer = ScriptedWriter()
        let model = model(writer: writer)
        await model.loadIfNeeded()
        let before = model.outline?.noteCount ?? 0

        let id = await model.createNote(in: "Journal")

        #expect(id == "note-new")
        #expect(writer.calls.withLock { $0 } == [.create("Journal")])
        #expect((model.outline?.noteCount ?? 0) > before, "the list must show what was just written")
    }

    @Test("a failed write keeps the vault on screen and says what happened")
    func aFailedWriteKeepsTheOutline() async {
        let writer = ScriptedWriter(failure: StorageError.Failed(what: "the disk is full"))
        let model = model(writer: writer)
        await model.loadIfNeeded()
        let outline = model.outline

        await model.deleteNote(id: "note-0")

        #expect(model.writeFailure != nil, "a write that did nothing must not be silent")
        #expect(model.outline == outline, "the vault is still readable, so it stays on screen")
    }

    @Test("a screen with no writer performs no write")
    func noWriterNoWrite() async {
        // The affordances are hidden in this case, so this is the belt behind
        // that brace: a code path that reached a write anyway must not appear
        // to have made one.
        let model = model(writer: nil)
        await model.loadIfNeeded()

        let id = await model.createNote(in: nil)

        #expect(id == nil)
        #expect(model.writeFailure == nil, "nothing was attempted, so nothing failed")
    }

    @Test("deleting a folder deletes every note under it, then its config")
    func folderDeleteCascadesThroughNotes() async {
        let writer = ScriptedWriter()
        let model = model(writer: writer, reader: TreeReader())
        await model.loadIfNeeded()

        await model.deleteFolder(path: "Work")

        // The core refuses a folder that still holds a note, so order matters.
        #expect(writer.calls.withLock { $0 } == [.delete("a"), .delete("b"), .deleteFolder("Work")])
    }

    @Test("a folder with no config row goes with its notes and asks the core for nothing more")
    func derivedFolderDeleteSkipsTheConfig() async {
        let writer = ScriptedWriter()
        let model = model(writer: writer, reader: TreeReader())
        await model.loadIfNeeded()

        await model.deleteFolder(path: "Loose")

        #expect(writer.calls.withLock { $0 } == [.delete("c")])
    }

    @Test("a new folder is created under its parent, and a blank name writes nothing")
    func newFolderPath() async {
        let writer = ScriptedWriter()
        let model = model(writer: writer, reader: TreeReader())
        await model.loadIfNeeded()

        await model.createFolder(named: "  Ideas ", in: "Work")
        await model.createFolder(named: "   ", in: nil)

        #expect(writer.calls.withLock { $0 } == [.createFolder("Work/Ideas")])
    }

    @Test("a folder icon is set and cleared through the writer")
    func folderIcon() async {
        let writer = ScriptedWriter()
        let model = model(writer: writer, reader: TreeReader())
        await model.loadIfNeeded()

        await model.setFolderIcon(path: "Work", to: "📚")
        await model.setFolderIcon(path: "Work", to: nil)

        #expect(writer.calls.withLock { $0 } == [.setFolderIcon("Work", "📚"), .setFolderIcon("Work", nil)])
    }

    @Test("the move to the vault root travels as the root, not as a folder named for it")
    func moveToRootPassesNil() async {
        let writer = ScriptedWriter()
        let model = model(writer: writer)

        await model.moveNote(id: "note-0", to: nil)

        #expect(writer.calls.withLock { $0 } == [.move("note-0", nil)])
    }
}
