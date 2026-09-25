import Foundation
import MemryCore
import Testing

@testable import Memry

// T156, the half that matters most: **is the browse screen reading the core,
// or something that behaves like it?**
//
// Phase 3 shipped five tiers that were implemented, tested behind fakes and
// never called, and every one passed the whole unit suite. So nothing here
// substitutes the reader. The genuine `VaultFiles`, the genuine
// `CoreVaultOpener` and the genuine `Vault.open` produce a real SQLite
// database in a temporary directory, and the **production** initializer
// `VaultBrowseViewModel(vault:executor:)` is what reads it.
//
// The two assertions are shaped so a **working** fake fails them:
//
//   * `theProductionModelHoldsTheCoreReader` fails the moment
//     `VaultBrowseViewModel(vault:executor:)` is pointed at anything other
//     than `CoreNotesReader` — including an in-memory reader that answers
//     correctly.
//   * `theCoreReaderAnswersFromARealDatabase` drives the production
//     initializer over a genuinely opened vault, so `CoreNotesReader` crosses
//     the real FFI and the phase it produces is the core's answer rather than
//     a script. **It does not on its own distinguish a working fake** — an
//     in-memory reader also answers `[]`, and `data.db` is T155's open rather
//     than this read — which is exactly why the type assertion above exists
//     and is stated rather than left implied.
//
// **No network call is made by this file, and no staging path is read.**
// `Vault.open` is a local SQLite create plus the forward-only migrations; the
// directory is a fresh `NSTemporaryDirectory()` subtree.

@MainActor
@Suite("T156 browse wiring", .serialized)
final class VaultBrowseWiringTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let opener: CoreVaultOpener
    private let executor = CoreExecutor(label: "t156-tests")
    private let vaultId = "t156-0123456789abcdef"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t156-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
        opener = CoreVaultOpener(files: files, executor: executor)
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    private var vaultDirectory: URL {
        root
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
    }

    @Test("the production model reads through the core, not through something shaped like it")
    func theProductionModelHoldsTheCoreReader() async throws {
        let vault = try await opener.open(vaultId)
        let model = VaultBrowseViewModel(vault: vault, executor: executor)
        #expect(model.reader is CoreNotesReader)
    }

    @Test("the core reader answers a real vault out of a real database file")
    func theCoreReaderAnswersFromARealDatabase() async throws {
        let vault = try await opener.open(vaultId)
        #expect(vault.id() == vaultId)
        let model = VaultBrowseViewModel(vault: vault, executor: executor)
        await model.loadIfNeeded()

        // A freshly created vault holds nothing, and that is `.empty` — never
        // a failure, and never `.ready` over an outline nobody built.
        #expect(model.phase == .empty)
        #expect(model.outline == nil)

        // The file only exists because the core's own open created it. An
        // in-memory reader reaches the same phase and leaves no file.
        let database = vaultDirectory.appendingPathComponent(VaultFiles.dataDatabaseName)
        #expect(FileManager.default.fileExists(atPath: database.path))
    }

    @Test("opening a vault points attachment paths at its images directory")
    func openingSetsTheImagesDirectory() async throws {
        let images = vaultDirectory.appendingPathComponent(VaultFiles.imagesDirectoryName, isDirectory: true)
        let expected = images.appending(path: "abc").standardizedFileURL
        // `AttachmentPaths` is process-wide, and suites that open other vaults
        // run in parallel with this one, so one may set it between this open
        // and the read. A few tries tell that apart from a missing assignment.
        var matched = false
        for _ in 0 ..< 3 where !matched {
            _ = try await opener.open(vaultId)
            matched = AttachmentPaths.url(for: "abc").standardizedFileURL == expected
        }
        #expect(matched)
    }
}
