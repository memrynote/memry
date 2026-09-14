import Foundation
import MemryCore
import Testing

@testable import Memry

// T157, the half that matters most: **is the note screen reading the core, or
// something that behaves like it?**
//
// Phase 3 shipped five tiers that were implemented, tested behind fakes and
// never called, and every one passed the whole unit suite. So nothing here
// substitutes the reader. The genuine `VaultFiles`, the genuine
// `CoreVaultOpener` and the genuine `Vault.open` produce a real SQLite
// database in a temporary directory; the **production** browse model
// `VaultBrowseViewModel(vault:executor:)` is built over it, and
// `NoteReadViewModel` is constructed from **that model's own `reader`** —
// which is exactly the expression `NotesListView.body`'s
// `navigationDestination(for: NoteRoute.self)` evaluates.
//
// The chain, named end to end:
//
//   `AuthRootView` → `VaultListView` → `NotesListView(vault:title:executor:)`
//   → `VaultBrowseViewModel(vault:executor:)` → `.reader` (`CoreNotesReader`)
//   → `.navigationDestination(for: NoteRoute.self)` → `NoteReadView(route:reader:)`
//   → `NoteReadViewModel` → `CoreNotesReader.read(id:)` → `CoreExecutor`
//   → `Vault.notes().read(id:)`.
//
// `theProductionModelHoldsTheCoreReader` fails the moment that expression is
// pointed at anything other than `CoreNotesReader` — **including an in-memory
// reader that answers correctly**, which is the only shape of break test that
// has caught a real bug in this project.
//
// **No network call is made by this file, and no staging path is read.**
// `Vault.open` is a local SQLite create plus the forward-only migrations; the
// directory is a fresh `NSTemporaryDirectory()` subtree.

@MainActor
@Suite("T157 note read wiring", .serialized)
final class NoteReadWiringTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let opener: CoreVaultOpener
    private let executor = CoreExecutor(label: "t157-tests")
    private let vaultId = "t157-0123456789abcdef"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t157-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
        opener = CoreVaultOpener(files: files, executor: executor)
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    /// The production expression, spelled exactly as `NotesListView.body`
    /// spells it: the browse model's own reader, handed to the note screen.
    private func productionModel(route: NoteRoute) async throws -> NoteReadViewModel {
        let vault = try await opener.open(vaultId)
        let browse = VaultBrowseViewModel(vault: vault, executor: executor)
        return NoteReadViewModel(route: route, reader: browse.reader)
    }

    @Test("the note screen reads through the core, not through something shaped like it")
    func theProductionModelHoldsTheCoreReader() async throws {
        let model = try await productionModel(route: NoteRoute(id: "does-not-exist"))
        #expect(model.reader is CoreNotesReader)
    }

    @Test("the core reader answers a real vault out of a real database file")
    func theCoreReaderAnswersFromARealDatabase() async throws {
        let model = try await productionModel(route: NoteRoute(id: "does-not-exist"))
        await model.loadIfNeeded()

        // A freshly created vault holds no note by that id, and that is
        // `.missing` — never `.unreadable`, and never a note with an empty
        // body. The core's own `read` returned `nil` across the real FFI.
        #expect(model.phase == .missing)
        #expect(model.preview == nil)

        // The file only exists because the core's own open created it. An
        // in-memory reader reaches the same phase and leaves no file.
        let database = root
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
            .appendingPathComponent(VaultFiles.dataDatabaseName)
        #expect(FileManager.default.fileExists(atPath: database.path))
    }
}
