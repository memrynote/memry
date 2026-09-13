import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T155's security half, and the proof for spec-defect 105.
//
// **What this file is actually for.** `VaultFiles.openingVault(_:open:)` was
// landed by T144 with no caller. A vault opened around it — rather than through
// it — leaves the SQLite write-ahead log, which holds recent note content in
// plaintext, at whatever protection class the container default happened to
// give the file. So the assertion that matters is not "the seam works"; T144
// proved that. It is **"the production opener goes through the seam, on every
// open"**, and the shape that can tell the difference is the one T147 used for
// the keychain: substitute a **working** platform underneath and watch the
// history, so a correct-but-bypassed implementation still fails.
//
// The platform substituted here is `FileAttributes`, and the substitution is
// `SystemFileAttributes` itself with a recorder around it. Every call really
// happens on the real filesystem; the recorder only says what was asked for and
// in what order. That is deliberate — a stub that answered from memory would
// pass whether or not SQLite ever created a sidecar, and the sidecars are the
// entire point.
//
// **The simulator cannot evidence the other half and is not asked to.** It does
// not implement data protection at all (spec-defects 104, 113):
// `setAttributes(.protectionKey:)` neither throws nor takes effect, and the URL
// resource value reads back the target's entitlement default for a file set to
// `.complete`, one set to `.none`, and one nothing was ever asked about. So an
// assertion about the **effective** class would pass with `VaultFiles` deleted.
// What is asserted here is the ordered history of what the shell **asked for**;
// whether a phone honours it is T161/T162's, on hardware.

/// `SystemFileAttributes`, with a note of every protection request.
///
/// Not a fake: every method below does the real thing. This is the "working
/// substitution" shape — it behaves correctly, so a test that passes with it
/// in place is testing the wiring rather than the stub.
private final class RecordingFileAttributes: FileAttributes, @unchecked Sendable {
    private let real = SystemFileAttributes()
    private let asked = Mutex<[String]>([])

    /// The last path component of every file a class was asked for, in order.
    var protectionHistory: [String] { asked.withLock { $0 } }

    func clearHistory() { asked.withLock { $0 = [] } }

    func exists(at url: URL) -> Bool { real.exists(at: url) }
    func isDirectory(at url: URL) -> Bool { real.isDirectory(at: url) }
    func createDirectory(at url: URL) throws { try real.createDirectory(at: url) }
    func setExcludedFromBackup(at url: URL) throws { try real.setExcludedFromBackup(at: url) }
    func excludedFromBackup(at url: URL) throws -> Bool? { try real.excludedFromBackup(at: url) }
    func availableBytes(at url: URL) throws -> UInt64? { try real.availableBytes(at: url) }

    func setProtection(_ value: FileProtectionType, at url: URL) throws {
        asked.withLock { $0.append(url.lastPathComponent) }
        try real.setProtection(value, at: url)
    }
}

@Suite("T155 opens every vault through the FileProtection seam", .serialized)
struct VaultOpeningTests {
    private let hub = CoreEvents()
    private let attributes = RecordingFileAttributes()
    private let root: URL
    private let files: VaultFiles
    private let opener: CoreVaultOpener
    private let vaultId = "t155-0123456789abcdef"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t155-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, attributes: attributes, root: root)
        // The **production** opener, with the production executor's shape. The
        // only substitution is the filesystem call recorder above.
        opener = CoreVaultOpener(files: files, executor: CoreExecutor(label: "t155-tests"))
    }

    private var vaultDirectory: URL {
        root
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
    }

    private func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: vaultDirectory.appendingPathComponent(name).path)
    }

    @Test("the open runs the sidecar sweep, which can only have happened after the open")
    func theOpenSweepsTheSidecars() async throws {
        var vault: Vault? = try await opener.open(vaultId)
        #expect(vault?.id() == vaultId)

        let history = attributes.protectionHistory
        // `data.db` exists only because the core's open created it, and
        // `reassertAfterOpen` is the only thing in `VaultFiles` that asks for a
        // class on it — `setProtection` is the Rust-called method and the core
        // never calls it here. So its presence in this history is the ordering:
        // the sweep ran, and it ran after the open.
        #expect(history.contains(VaultFiles.dataDatabaseName))
        #expect(history.contains("data.db-wal"))
        #expect(history.contains("data.db-shm"))
        // The directory tree was hardened before any of it: the root is the
        // first thing `prepareVault` touches, the vault directory the third.
        #expect(history.first == root.lastPathComponent)
        #expect(history.contains(vaultId))

        // The sidecars are real files on disk, not names the seam invented.
        #expect(exists("data.db-wal"))
        #expect(exists("data.db-shm"))

        vault = nil
    }

    /// The reason `reassertAfterOpen`'s doc says "call it after **every** open".
    @Test("a second open of the same vault sweeps the sidecars again")
    func aSecondOpenSweepsAgain() async throws {
        var vault: Vault? = try await opener.open(vaultId)
        #expect(vault != nil)
        // A clean close. Dropping the handle frees the Rust object, which drops
        // the connection, which checkpoints and removes `-wal` and `-shm`.
        vault = nil
        #expect(!exists("data.db-wal"), "a clean close should have removed the write-ahead log")
        #expect(!exists("data.db-shm"))

        attributes.clearHistory()
        var second: Vault? = try await opener.open(vaultId)
        #expect(second?.id() == vaultId)

        // These are **new files with new attributes** — the ones a "first open
        // only" implementation would never touch. This is the assertion the
        // defect is about.
        let history = attributes.protectionHistory
        #expect(history.contains("data.db-wal"))
        #expect(history.contains("data.db-shm"))
        #expect(exists("data.db-wal"))

        second = nil
    }

    @Test("a vault id that is not a usable path component is refused before anything is opened")
    func anUnusableVaultIdIsRefused() async throws {
        // The "an unparseable input must not read as an empty one" rule, one
        // layer down: an empty id would resolve to the vaults directory itself
        // and open a database beside every other vault's.
        await #expect(throws: StorageError.self) {
            _ = try await opener.open("")
        }
        #expect(attributes.protectionHistory.isEmpty)
    }
}
