import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T144. **Read `simulatorIgnoresDataProtectionEntirely` first.** It is the
// measurement the rest of this file is arranged around, and it says that the
// assertion T144 asks for — the *effective* class read back from `data.db` and
// both sidecars — cannot be made on a simulator at all.
//
// Measured on the iPhone 17 simulator, iOS 26.5, by writing a class and reading
// it back through both platform APIs:
//
//   * `FileManager.attributesOfItem(atPath:)[.protectionKey]` is **nil** for
//     every file, whatever class was set on it;
//   * `URL.resourceValues(.fileProtectionKey)` returns
//     `NSURLFileProtectionCompleteUntilFirstUserAuthentication` for **every**
//     file — one set to `.complete`, one set to `.none`, and one never touched
//     — and `nil` for a directory. It is the target's entitlement default
//     echoed back, not the file's class;
//   * `setAttributes(.protectionKey:)` does not throw, and does nothing.
//
// So a test that asserted "the class read back equals
// NSFileProtectionCompleteUntilFirstUserAuthentication" would **pass with this
// entire seam deleted**, because that is what the platform says about an
// untouched file. That is spec-defect 91's shape exactly, and the only reason
// it was caught is that every fixture here writes the *wrong* class first and
// asserts it reads back wrong before the code under test runs. It did not.
//
// What that leaves, honestly:
//
// - `VaultFilesRealFilesystemTests` covers what this platform does implement —
//   directory creation, the path layout, backup exclusion (which does round
//   trip), the identifier check, the failure arms, the event. It calls the real
//   `setAttributes` on real files, so the write path is exercised end to end;
//   it just cannot observe the result.
// - `VaultFilesSubstitutedPlatformTests` carries the sidecar evidence instead,
//   and carries it as an ordered history: which paths the seam asked to protect,
//   with which class, in which order relative to the open. A missing sidecar, a
//   wrong class and a sweep that ran before the open are three distinct
//   failures of one assertion.
//
// **Neither suite is evidence that the bytes are protected.** Whether a device
// honours the class, and whether a background task before first unlock can
// still read the database, is device evidence and belongs to T161/T162.

/// The literal from `Memry.entitlements`
/// (`com.apple.developer.default-data-protection`), which is also
/// `FileProtectionType.completeUntilFirstUserAuthentication.rawValue`. Written
/// out so the value the tests demand is the value a reader of the entitlement
/// file can compare by eye. `NSFileProtectionComplete` is a *different* class.
private let expectedClass = "NSFileProtectionCompleteUntilFirstUserAuthentication"

private func excludedFromBackup(_ url: URL) throws -> Bool? {
    try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
}

/// `data.db` plus the two sidecars an open in WAL mode creates.
private let openedDatabaseNames = ["data.db", "data.db-wal", "data.db-shm"]

/// `.Failed`'s reason, or a description of why it was not a `.Failed`. Returns
/// `nil` when nothing was thrown, so a test can assert on the reason and on the
/// fact that there was one in a single expression.
private func failureReason(_ body: () throws -> Void) -> String? {
    do {
        try body()
        return nil
    } catch let error as StorageError {
        if case let .Failed(what) = error { return what }
        return "a StorageError that is not Failed: \(error)"
    } catch {
        return "not a StorageError"
    }
}

@Suite("VaultFiles on the real filesystem")
struct VaultFilesRealFilesystemTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let vaultId = "vault-0123456789abcdef"

    /// A fresh directory per test, under the simulator's own temporary
    /// directory, which it discards.
    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t144-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
    }

    private var vaultDirectory: URL {
        root
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
    }

    @discardableResult
    private func makeOpenedDatabase(in directory: URL) -> [URL] {
        let urls = openedDatabaseNames.map { directory.appendingPathComponent($0) }
        for url in urls { FileManager.default.createFile(atPath: url.path, contents: Data([0x00])) }
        return urls
    }

    /// Whether this build is running on real hardware. A simulator and a phone
    /// disagree about data protection in a way that decides what the rest of
    /// this file can claim, so the platform is read rather than assumed.
    private static let isDevice: Bool = {
        #if targetEnvironment(simulator)
        return false
        #else
        return true
        #endif
    }()

    /// The measurement this file is built around, and it asserts a **different
    /// thing on each platform** — because the platforms really do differ, and a
    /// single assertion would have to be either a simulator claim that fails on
    /// a phone or a device claim that passes vacuously on a simulator. It was
    /// the first for one session (spec-defect 104) and failed the moment the
    /// suite first ran on hardware, which is the correct outcome for a test
    /// written about an environment.
    ///
    /// On a **simulator**: data protection is not implemented at all, and the
    /// read-back is one constant for a file set to `.complete`, a file set to
    /// `.none`, and a file nothing was ever asked about. That is why the sidecar
    /// evidence here is an ordered history of what the seam **asked for** rather
    /// than what the filesystem reports.
    ///
    /// On a **device**: the effective class is real, and this is where
    /// defect 104 sent T144's original clause. `data.db` and both sidecars must
    /// read back `NSFileProtectionCompleteUntilFirstUserAuthentication` — the
    /// class `Memry.entitlements` declares, and **not** Complete Protection,
    /// which would lock the database against the background refresh that runs
    /// before the first unlock after a reboot.
    @Test("data protection: the simulator ignores it, a device enforces it")
    func dataProtectionBehavesAsThePlatformAllows() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let requests: [(String, FileProtectionType?)] = [
            ("untouched", nil), ("complete", .complete), ("none", .none)
        ]
        var readBack: [String?] = []
        for (name, requested) in requests {
            let url = root.appendingPathComponent(name)
            FileManager.default.createFile(atPath: url.path, contents: Data([0x01]))
            if let requested {
                try FileManager.default.setAttributes([.protectionKey: requested], ofItemAtPath: url.path)
            }
            if !Self.isDevice {
                // Not reported at all by the attributes API on a simulator.
                #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey] == nil, "\(name)")
            }
            readBack.append(try url.resourceValues(forKeys: [.fileProtectionKey]).fileProtection?.rawValue)
        }

        if Self.isDevice {
            // Measured on an iPhone 12 Pro, iOS 27.0, and neither half was
            // obvious enough to assume — the first draft asserted both wrongly.
            //
            // 1. The two APIs use different prefixes. `URL.resourceValues`
            //    answers `NSURLFileProtection*`; `FileProtectionType.rawValue`
            //    is `NSFileProtection*`. Comparing the strings across them
            //    fails on a correctly protected file, so compare the typed
            //    values.
            // 2. **The entitlement is a floor, not a default.** A file
            //    explicitly set to `.none` still reads back as
            //    `completeUntilFirstUserAuthentication`, because
            //    `com.apple.developer.default-data-protection` applies to the
            //    whole container. So the app cannot lower protection below the
            //    declared class even by asking — which is a stronger guarantee
            //    than the entitlement being merely what unmarked files get.
            //    Raising it still works: `.complete` is honoured.
            let typed = try requests.map { name, _ in
                try root.appendingPathComponent(name)
                    .resourceValues(forKeys: [.fileProtectionKey]).fileProtection
            }
            #expect(typed[1] == .complete, "an explicit .complete is honoured")
            #expect(
                typed[2] == .completeUntilFirstUserAuthentication,
                "the entitlement floors .none at the container's class"
            )
            #expect(typed[0] == .completeUntilFirstUserAuthentication, "an untouched file inherits the floor")
        } else {
            // One constant for all three, so the value carries no information
            // about what was asked — including for the untouched file. **That
            // invariance is the whole claim**, and it is asserted as invariance
            // rather than as a literal string: an earlier draft pinned the
            // string and pinned a directory's read-back to `nil`, and both are
            // properties of one simulator build rather than of simulators. The
            // local simulator and the CI simulator disagreed about the
            // directory, and the string is an OS-version detail. If a future
            // simulator ever did honour data protection, these three would
            // stop agreeing and this fails — which is the regression worth
            // catching.
            #expect(Set(readBack).count == 1, "\(readBack)")
            // And it is a value, not an absence: "could not tell" must never be
            // able to satisfy the invariance above by making all three `nil`.
            #expect(readBack.allSatisfy { $0 != nil }, "\(readBack)")
        }
    }

    /// T144's original clause, which defect 104 moved here because a simulator
    /// cannot evidence it: the **effective** class on the database and on both
    /// sidecars, read back after the open. Skipped rather than vacuously passed
    /// off-device, so a green simulator run never reads as this having held.
    /// The gate is `.enabled(if:)` and **not** `try #require(Self.isDevice)`:
    /// `#require` records an expectation failure when its condition is false,
    /// so the doc comment above said "skipped" while the code failed the test
    /// on every simulator run. A trait skips; `#require` fails.
    @Test(
        "on device the database and both sidecars are protected until first unlock",
        .enabled(if: VaultFilesRealFilesystemTests.isDevice, "the effective class is only observable on hardware")
    )
    func effectiveClassOnDeviceIsUntilFirstUnlock() async throws {

        let opened = try await files.openingVault(vaultId) { directory in
            makeOpenedDatabase(in: directory)
        }

        for url in opened {
            let effective = try url.resourceValues(forKeys: [.fileProtectionKey]).fileProtection
            #expect(
                effective == .completeUntilFirstUserAuthentication,
                "\(url.lastPathComponent) is \(effective?.rawValue ?? "nil")"
            )
            // Complete Protection would lock the database against the
            // background refresh that runs before the first unlock.
            #expect(effective != .complete, "\(url.lastPathComponent)")
        }
    }

    @Test("the application support directory is created and excluded from backup")
    func applicationSupportIsHardened() throws {
        let path = try files.applicationSupportDir()

        #expect(path == root.path)
        #expect(FileManager.default.fileExists(atPath: path))
        #expect(try excludedFromBackup(root) == true)
    }

    @Test("with no override the root is Application Support under the bundle identifier")
    func defaultRootFollowsTheContractedLayout() throws {
        let path = try VaultFiles(emitter: hub.emitter).applicationSupportDir()
        let bundleIdentifier = try #require(Bundle.main.bundleIdentifier)

        #expect(path.hasSuffix("/Library/Application Support/\(bundleIdentifier)"))
    }

    @Test("preparing a vault creates the layout and excludes every level from backup")
    func prepareVaultCreatesTheLayout() throws {
        let directory = try files.prepareVault(vaultId)
        let images = directory.appendingPathComponent(VaultFiles.imagesDirectoryName, isDirectory: true)

        #expect(directory == vaultDirectory)
        #expect(FileManager.default.fileExists(atPath: images.path))
        // Every level, not only the leaf: the intermediates would otherwise be
        // created as a side effect of `withIntermediateDirectories`.
        for level in [root, directory.deletingLastPathComponent(), directory, images] {
            #expect(try excludedFromBackup(level) == true, "\(level.lastPathComponent)")
        }
    }

    /// The write path really runs — `setAttributes` on a real `-wal` and a real
    /// `-shm`, in the real order, through the real `FileManager`. What it
    /// cannot do here is observe the result; see
    /// ``simulatorIgnoresDataProtectionEntirely`` and, for the class itself,
    /// `VaultFilesSubstitutedPlatformTests`.
    @Test("the sweep runs against real files, over the database and both sidecars")
    func sweepRunsAgainstRealFiles() throws {
        try files.prepareVault(vaultId)
        makeOpenedDatabase(in: vaultDirectory)

        // data.db, -wal, -shm, the vault directory and images/.
        #expect(try files.reassertAfterOpen(vaultId) == 5)
    }

    @Test("a sweep that finds no database is a failure, not a success that protected nothing")
    func sweepBeforeTheOpenIsAFailure() throws {
        try files.prepareVault(vaultId)

        let reason = failureReason { _ = try files.reassertAfterOpen(vaultId) }

        #expect(reason?.contains("before the open") == true)
        #expect(reason?.contains("/") == false)
    }

    @Test("a class asked for on a path that is not there is a failure")
    func setProtectionOnAMissingPathFails() {
        let missing = root.appendingPathComponent("not-there.db")

        let reason = failureReason {
            try files.setProtection(path: missing.path, class: .completeUntilFirstUserAuthentication)
        }

        #expect(reason?.contains("does not exist") == true)
        #expect(reason?.contains("not-there") == false)
    }

    @Test("a vault identifier that is empty or escapes the directory is refused")
    func unusableVaultIdentifiersAreRefused() {
        for identifier in ["", ".", "..", "a/b", "../../etc", "nul\0byte"] {
            let reason = failureReason { _ = try files.prepareVault(identifier) }
            #expect(reason?.contains("not a usable path component") == true, "\(identifier.debugDescription)")
        }

        // Nothing was created on the way to refusing, including the vaults
        // directory an empty identifier would otherwise have resolved to.
        let vaults = root.appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
        #expect(!FileManager.default.fileExists(atPath: vaults.path))
    }

    @Test("available capacity is a number that was actually read")
    func availableBytesIsReadable() throws {
        #expect(try files.availableBytes() > 0)
    }

    /// The sentinel pattern: emit a known last element, `finish()`, drain to the
    /// end, compare the whole history. Draining a fixed count instead hangs
    /// rather than fails when the bug is a missing yield (spec-defect 99).
    @Test("one storage hint per sweep, carrying the vault it swept")
    func sweepEmitsOneStorageHint() async throws {
        let stream = hub.consume()
        try files.prepareVault(vaultId)
        makeOpenedDatabase(in: vaultDirectory)

        _ = try files.reassertAfterOpen(vaultId)

        hub.emitter.emit(CoreEvent(.scenePhase))
        hub.finish()

        var received: [CoreEvent] = []
        for await event in try #require(stream) { received.append(event) }
        #expect(received == [CoreEvent(.storage, scope: .vault(vaultId)), CoreEvent(.scenePhase)])
    }
}

@Suite("VaultFiles over a substituted platform")
struct VaultFilesSubstitutedPlatformTests {
    private let root = URL(fileURLWithPath: "/t144-substituted", isDirectory: true)
    private let vaultId = "vault-1"

    private func vaultFiles(_ responses: StubFileAttributes.Responses = .init()) -> (VaultFiles, StubFileAttributes) {
        let stub = StubFileAttributes(responses)
        return (VaultFiles(emitter: CoreEvents().emitter, attributes: stub, root: root), stub)
    }

    /// T144's headline, carried the only way this platform allows: not "the
    /// class the file ended up with" but "the class the seam asked for, on which
    /// paths, in which order relative to the open".
    ///
    /// One assertion, four distinct failures. Drop the sidecars from the sweep
    /// and the three `data.db-*` entries vanish. Set the wrong class and the
    /// second assertion fails. Re-assert before the open instead of after and
    /// `open` moves to the end. Skip `images/` and it is missing from both
    /// halves.
    @Test("opening a vault asks for the entitlement's class on the database and both sidecars, after the open")
    func openingAVaultProtectsTheSidecarsAfterTheOpen() async throws {
        let (files, stub) = vaultFiles()

        let opened = try await files.openingVault(vaultId) { directory in
            stub.opened(openedDatabaseNames, in: directory)
            return 42
        }

        #expect(opened == 42)
        #expect(stub.history == [
            "protect t144-substituted", "protect vault", "protect vault-1", "protect images",
            "open",
            "protect vault-1", "protect images",
            "protect data.db", "protect data.db-wal", "protect data.db-shm"
        ])
        #expect(stub.protections.allSatisfy { $0.protection == expectedClass })
        // `-journal` did not exist, so it was not asked for: the sweep covers
        // the sidecars that are there rather than every name it knows.
        #expect(stub.history.contains("protect data.db-journal") == false)
    }

    /// A clean close deletes `-wal` and `-shm`, and the next open creates new
    /// files with new attributes. "After first open" is when the sidecars first
    /// appear, not the only time they do.
    @Test("a second open sweeps the sidecars that second open created")
    func secondOpenSweepsFreshSidecars() async throws {
        let (files, stub) = vaultFiles()
        _ = try await files.openingVault(vaultId) { stub.opened(openedDatabaseNames, in: $0) }

        let directory = root
            .appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
        stub.closed(["data.db-wal", "data.db-shm"], in: directory)
        stub.clearHistory()
        _ = try await files.openingVault(vaultId) { stub.opened(["data.db-wal", "data.db-shm"], in: $0) }

        #expect(stub.history.suffix(3) == [
            "protect data.db", "protect data.db-wal", "protect data.db-shm"
        ])
    }

    @Test("a class the core sets on a database reaches that database's sidecars")
    func setProtectionCoversSidecars() throws {
        let (files, stub) = vaultFiles(.init(everythingExists: true))

        try files.setProtection(path: "/t144-substituted/data.db", class: .completeUntilFirstUserAuthentication)

        #expect(stub.history == [
            "protect data.db", "protect data.db-wal", "protect data.db-shm", "protect data.db-journal"
        ])
        #expect(stub.protections.allSatisfy { $0.protection == expectedClass })
    }

    /// The mapping is not hard-wired to one class: `complete` is a different
    /// class and must arrive as itself, or the exhaustive switch is decoration.
    @Test("the other class maps to the other class")
    func completeMapsToComplete() throws {
        let (files, stub) = vaultFiles(.init(everythingExists: true))

        try files.setProtection(path: "/t144-substituted/images/chunk", class: .complete)

        #expect(stub.protections.isEmpty == false)
        #expect(stub.protections.allSatisfy { $0.protection == "NSFileProtectionComplete" })
    }

    @Test("a directory that cannot be created is never reported as created")
    func creationFailureIsReported() {
        let (files, _) = vaultFiles(.init(createDirectoryFails: true))

        let reason = failureReason { _ = try files.applicationSupportDir() }

        #expect(reason?.contains("could not create a directory") == true)
        // A Foundation error stringifies with the full path in it. The code
        // crosses; the path does not.
        #expect(reason?.contains("/") == false)
        #expect(reason?.contains("NSCocoaErrorDomain") == true)
    }

    @Test("a directory that reports created and is not there is a failure")
    func creationThatDidNotHappenIsReported() {
        let (files, _) = vaultFiles(.init(createDirectoryIsALie: true))

        let reason = failureReason { _ = try files.applicationSupportDir() }

        #expect(reason?.contains("reported as created is not there") == true)
    }

    @Test("a backup exclusion that does not read back is a failure, whether it reads false or not at all")
    func exclusionThatDidNotStickIsReported() {
        for readsBack in [false, nil] as [Bool?] {
            let (files, _) = vaultFiles(.init(exclusionReadsBack: readsBack))

            let reason = failureReason { _ = try files.applicationSupportDir() }

            #expect(reason?.contains("did not read back") == true, "\(String(describing: readsBack))")
        }
    }

    @Test("a capacity that cannot be read is a failure, never zero")
    func unreadableCapacityIsNotZero() {
        let (files, _) = vaultFiles(.init(availableBytes: nil))

        let reason = failureReason { _ = try files.availableBytes() }

        #expect(reason?.contains("available capacity") == true)
    }

    @Test("every failure this seam mints is Failed, and never IndexRebuildRequired")
    func everyFailureIsFailed() {
        // `IndexRebuildRequired` makes the core delete and rebuild `index.db`.
        // An attribute this seam could not set is not a corrupt index.
        let cases: [(String, () throws -> Void)] = [
            ("create", { _ = try self.vaultFiles(.init(createDirectoryFails: true)).0.applicationSupportDir() }),
            ("exclude", { _ = try self.vaultFiles(.init(exclusionReadsBack: false)).0.applicationSupportDir() }),
            ("capacity", { _ = try self.vaultFiles(.init(availableBytes: nil)).0.availableBytes() }),
            ("sweep", { _ = try self.vaultFiles().0.reassertAfterOpen(self.vaultId) })
        ]

        for (name, body) in cases {
            let reason = failureReason(body)
            #expect(reason != nil, "\(name)")
            #expect(reason?.hasPrefix("a StorageError that is not Failed") == false, "\(name)")
        }
    }
}

/// Substitutes Foundation, not the seam: paths in, outcomes out, so the logic
/// under test is the real one.
///
/// It records an ordered history rather than a set, because half of what T144
/// asks for is an ordering — the sidecars do not exist until the open creates
/// them, so "which files" and "when" are the same question.
private final class StubFileAttributes: FileAttributes {
    struct Responses: Sendable {
        var everythingExists = false
        var createDirectoryFails = false
        /// The create succeeds and the directory still is not there.
        var createDirectoryIsALie = false
        var exclusionReadsBack: Bool? = true
        var availableBytes: UInt64? = 1024
    }

    struct Protection: Sendable, Equatable {
        var name: String
        var protection: String
    }

    private let responses: Responses
    private let state = Mutex(State())

    private struct State {
        var present: Set<String> = []
        var protections: [Protection] = []
        var history: [String] = []
    }

    init(_ responses: Responses) {
        self.responses = responses
    }

    var protections: [Protection] { state.withLock { $0.protections } }
    var history: [String] { state.withLock { $0.history } }

    /// What SQLite does when the core opens the database: the files appear.
    /// Recorded in the same history as the protection calls, so "after the
    /// open" is an assertion rather than a comment.
    func opened(_ names: [String], in directory: URL) {
        state.withLock { state in
            for name in names { state.present.insert(directory.appendingPathComponent(name).path) }
            state.history.append("open")
        }
    }

    /// What a clean close does: `-wal` and `-shm` are deleted.
    func closed(_ names: [String], in directory: URL) {
        state.withLock { state in
            for name in names { state.present.remove(directory.appendingPathComponent(name).path) }
        }
    }

    func clearHistory() {
        state.withLock { $0.history = [] }
    }

    func exists(at url: URL) -> Bool {
        responses.everythingExists || state.withLock { $0.present.contains(url.path) }
    }

    func isDirectory(at url: URL) -> Bool { exists(at: url) }

    func createDirectory(at url: URL) throws {
        if responses.createDirectoryFails { throw NSError(domain: NSCocoaErrorDomain, code: 513, userInfo: nil) }
        guard !responses.createDirectoryIsALie else { return }
        state.withLock { $0.present.insert(url.path) }
    }

    func setProtection(_ value: FileProtectionType, at url: URL) throws {
        state.withLock {
            $0.protections.append(Protection(name: url.lastPathComponent, protection: value.rawValue))
            $0.history.append("protect \(url.lastPathComponent)")
        }
    }

    func setExcludedFromBackup(at url: URL) throws {}

    func excludedFromBackup(at url: URL) throws -> Bool? { responses.exclusionReadsBack }

    func availableBytes(at url: URL) throws -> UInt64? { responses.availableBytes }
}
