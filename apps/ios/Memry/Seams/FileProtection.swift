import Foundation
import MemryCore

/// T144. The `FileProtection` seam over the iOS data-protection filesystem
/// (data-model §A.0, research R11, `contracts/shell-seams.md` row 2).
///
/// **The type is not called `FileProtection`.** The generated protocol already
/// owns that name, and it cannot even be qualified past a clash: `MemryCore`
/// is also a public enum inside its own module, so `MemryCore.FileProtection`
/// resolves to a member of *that* and does not compile. A class of the same
/// name would therefore be unreferenceable from a file importing both modules
/// — the tests first. `Keychain: SecureStore` set the precedent: the seam is
/// named for the platform thing it owns, which here is the vault's files.
///
/// **Rust calls the four protocol methods, so they never call Rust.** UniFFI
/// dispatches them synchronously on the calling Rust thread, which may hold the
/// connection's lock; the whole job is to do the platform thing and return.
/// The one thing this seam says out loud it says through ``CoreEventEmitter``,
/// whose `emit` is synchronous, non-throwing and `Void` (`shell-seams.md`
/// §"There is no event seam"). Construct it with an emitter, never with
/// `CoreEvents` and never with `CoreExecutor`.
///
/// **The sidecars are the point, and the core cannot see them.** Nothing in
/// `crates/memry-core/src/seams/storage.rs` names `-wal` or `-shm`; the core
/// asks for a class on *a path*. SQLite creates the write-ahead log when it
/// opens the database, not when the directory is made, and the log holds recent
/// note content in plaintext. So the only place sidecar coverage can live is
/// here, and it lives in two places on purpose:
///
///   * ``setProtection(path:class:)`` covers the sidecars of a database it is
///     handed, for the ones that already exist when the core calls;
///   * ``reassertAfterOpen(_:)`` covers the ones the open just created, and
///     ``openingVault(_:open:)`` is the shape that makes the ordering
///     structural rather than remembered.
///
/// **Every failure here is `StorageError.Failed`.** The other five variants
/// belong to the storage layer, and one of them would be actively harmful:
/// `IndexRebuildRequired` makes the core delete and rebuild `index.db`, so a
/// seam that borrowed it would turn "I could not set an attribute" into a full
/// FTS rebuild (`shell-seams.md`, the `IndexRebuildRequired` row). `OutOfSpace`
/// is the core's conclusion from ``availableBytes()``, never this seam's.
///
/// **A simulator cannot evidence any of this, and the measurement is in the
/// tests.** `FileProtectionTests.simulatorIgnoresDataProtectionEntirely`
/// records what an iPhone 17 simulator on iOS 26.5 actually does:
/// `setAttributes(.protectionKey:)` neither throws nor takes effect,
/// `attributesOfItem` never returns the key, and the URL resource value returns
/// the target's entitlement default for *every* file — one set to `.complete`,
/// one set to `.none`, and one never touched. So the effective class cannot be
/// read back there at all, and a test that asserted it equals
/// `NSFileProtectionCompleteUntilFirstUserAuthentication` would pass with this
/// file deleted. The class this seam asks for is asserted through a substituted
/// platform instead. **Whether a device honours the class, and whether a
/// background task before first unlock can still read the database, is device
/// evidence and belongs to T161/T162.**
final class VaultFiles: FileProtection {
    /// data-model §A.0's layout, verbatim:
    /// `Application Support/<bundle>/vault/<vaultId>/{data.db,index.db,images/}`.
    /// These names are read by the core, which joins them onto the string
    /// ``applicationSupportDir()`` returns; changing one strands the database of
    /// every install that already wrote it.
    static let vaultsDirectoryName = "vault"
    static let dataDatabaseName = "data.db"
    static let indexDatabaseName = "index.db"
    static let imagesDirectoryName = "images"

    /// SQLite's companions to a database file. `-wal` and `-shm` exist only
    /// while a connection is open in WAL mode; `-journal` is what a build that
    /// fell back to a rollback journal writes instead. All three can hold note
    /// content that has not reached the main file yet, so all three are swept.
    static let sidecarSuffixes = ["-wal", "-shm", "-journal"]

    private let emitter: CoreEventEmitter
    private let attributes: any FileAttributes
    private let rootOverride: URL?

    /// - Parameters:
    ///   - attributes: the filesystem calls, injected so the arms a real
    ///     filesystem will not produce on demand — a directory that cannot be
    ///     created, an exclusion flag that does not read back — are still
    ///     exercised. Production passes the default.
    ///   - root: replaces `Application Support/<bundle>`. Tests only; a
    ///     production caller passes nothing, because the path is the contract.
    init(
        emitter: CoreEventEmitter,
        attributes: any FileAttributes = SystemFileAttributes(),
        root: URL? = nil
    ) {
        self.emitter = emitter
        self.attributes = attributes
        rootOverride = root
    }

    // MARK: - The seam, called from Rust

    /// Creates `Application Support/<bundle>/` if it is absent and returns it.
    ///
    /// iOS does not create `Application Support` for an app, so this cannot be
    /// a pure lookup: the core joins `vault/<vaultId>` onto the result and
    /// opens a database there, and `Connection::open` fails on a missing
    /// parent. The `<bundle>` component is data-model §A.0's, and matches
    /// Apple's guidance that an iOS app keeps its own subdirectory here.
    func applicationSupportDir() throws -> String {
        let root = try resolvedRoot()
        try harden(directory: root)
        return root.path
    }

    /// Applies `class` to `path`, **and to the sidecars of `path` that exist**.
    ///
    /// The fan-out is not the seam taking a liberty: the core has one path and
    /// no vocabulary for a write-ahead log, so a literal implementation would
    /// leave the plaintext log at whatever default applied. It covers only
    /// sidecars that exist right now, which before the first open is none of
    /// them — hence ``reassertAfterOpen(_:)``.
    func setProtection(path: String, `class` protectionClass: ProtectionClass) throws {
        let url = URL(fileURLWithPath: path)
        guard attributes.exists(at: url) else {
            // A class asked for on a path that is not there did nothing. Saying
            // so is the difference between "protected" and "could not tell".
            throw Self.failure("set a protection class on a path that does not exist")
        }
        try apply(protectionClass, to: url)
        for sidecar in Self.sidecars(of: url) where attributes.exists(at: sidecar) {
            try apply(protectionClass, to: sidecar)
        }
    }

    /// FR-024. Verified by reading the flag back: an exclusion that did not
    /// take must not return as if it had, because the caller's next move is to
    /// write a database it believes will never leave the device.
    func excludeFromBackup(path: String) throws {
        try exclude(URL(fileURLWithPath: path))
    }

    /// Free space, so a first sync can refuse before it fills the disk.
    ///
    /// `volumeAvailableCapacityForImportantUsage` rather than the raw free
    /// count: it is what iOS will actually let the app have after purgeable
    /// space is reclaimed, and the core's decision is about data the user
    /// expects to keep. A value that cannot be read throws rather than
    /// returning zero — zero is "the disk is full", which is a different claim.
    func availableBytes() throws -> UInt64 {
        let probe = try resolvedRoot()
        let target = attributes.exists(at: probe) ? probe : URL(fileURLWithPath: NSHomeDirectory())
        guard let bytes = try attributes.availableBytes(at: target) else {
            throw Self.failure("could not read the volume's available capacity")
        }
        return bytes
    }

    // MARK: - The shell's own vault handling, never called from Rust

    /// Creates `vault/<vaultId>/` and `images/` at the class, excluded from
    /// backup, and returns the vault directory.
    ///
    /// Every level is hardened, not only the leaf: `createDirectory` with
    /// intermediates would otherwise leave `Application Support/<bundle>` and
    /// `vault/` created by a side effect and classed by whatever default
    /// applied.
    @discardableResult
    func prepareVault(_ vaultId: String) throws -> URL {
        let directory = try vaultDirectory(vaultId)
        let levels = [
            try resolvedRoot(),
            directory.deletingLastPathComponent(),
            directory,
            directory.appendingPathComponent(Self.imagesDirectoryName, isDirectory: true)
        ]
        for level in levels {
            try harden(directory: level)
        }
        return directory
    }

    /// Re-asserts `completeUntilFirstUserAuthentication` on both databases and
    /// on every sidecar the open created. Returns how many files it touched.
    ///
    /// **Call it after every open, not only the first.** A clean close deletes
    /// `-wal` and `-shm`, and the next open creates new files with new
    /// attributes, so "first open" describes when the files first appear rather
    /// than the only time they do. A checkpoint is the other half of that
    /// question and needs nothing: `wal_checkpoint` writes into, or truncates,
    /// the existing file, so the attribute rides on the inode that already has
    /// it. Re-asserting is idempotent, so running it more often than strictly
    /// needed costs a handful of `setattrlist` calls and nothing else.
    ///
    /// It must run **while a connection is still open**, which is the other
    /// reason ``openingVault(_:open:)`` exists: after a clean close there are no
    /// sidecars left to re-assert, and a sweep that found nothing would be a
    /// success that protected nothing.
    @discardableResult
    func reassertAfterOpen(_ vaultId: String) throws -> Int {
        let directory = try vaultDirectory(vaultId)
        let databases = Self.databaseFiles(in: directory).filter { attributes.exists(at: $0) }
        guard databases.contains(where: { Self.isDatabase($0) }) else {
            // The sweep ran before the open created anything. Reporting success
            // would be a re-assertion that re-asserted nothing.
            throw Self.failure("re-assertion found no database, so it ran before the open")
        }

        var touched: [URL] = [directory]
        let images = directory.appendingPathComponent(Self.imagesDirectoryName, isDirectory: true)
        if attributes.exists(at: images) { touched.append(images) }
        touched.append(contentsOf: databases)

        for url in touched {
            try apply(.completeUntilFirstUserAuthentication, to: url)
        }

        Log.storage.info("re-asserted the vault data-protection class", .count(touched.count))
        emitter.emit(CoreEvent(.storage, scope: .vault(vaultId)))
        return touched.count
    }

    /// Prepare, open, re-assert — in that order, with no way to skip the third.
    ///
    /// The ordering constraint in T144 ("after first open") cannot be satisfied
    /// by the seam alone: the core opens the database and never calls back
    /// afterwards, so nothing in Rust can trigger the re-assertion. It cannot be
    /// left to a convention at the call site either — Phase 3 shipped five
    /// tiers that were implemented, tested, and never called. So the ordering
    /// lives in a function shaped like the operation: a caller that opens a
    /// vault through this one cannot forget the sweep, because the sweep is on
    /// the other side of its own closure.
    ///
    /// `open` receives the vault directory and is expected to be the core call
    /// that opens `data.db` and `index.db`. Its connections must still be open
    /// when it returns.
    func openingVault<T>(_ vaultId: String, open: (URL) async throws -> T) async throws -> T {
        let directory = try prepareVault(vaultId)
        let opened = try await open(directory)
        try reassertAfterOpen(vaultId)
        return opened
    }

    // MARK: - Paths

    /// `Application Support/<bundle>`, or the test override.
    private func resolvedRoot() throws -> URL {
        if let rootOverride { return rootOverride }
        let search = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        guard let support = search.first else {
            throw Self.failure("the application support directory could not be located")
        }
        guard let bundleIdentifier = Bundle.main.bundleIdentifier, !bundleIdentifier.isEmpty else {
            // Falling back to a fixed name would put two differently-signed
            // builds into one database directory. Refusing is the safe half.
            throw Self.failure("the bundle identifier is missing")
        }
        return support.appendingPathComponent(bundleIdentifier, isDirectory: true)
    }

    /// `<root>/vault`, the directory every vault directory sits in.
    ///
    /// **T159 needs this and nothing else from here.** Sign-out removes both
    /// databases and `images/` for every vault on the account (data-model §B),
    /// and the only thing this file guards that a remover cannot recompute is
    /// **where** they are: `resolvedRoot()` is private, it refuses a build with
    /// no bundle identifier rather than falling back to a fixed name, and it is
    /// what the test root override replaces. A remover that rebuilt the path
    /// itself would be a second copy of the layout, and the two would drift the
    /// day `<bundle>` moves — so the path stays owned here and the deletion
    /// lives in `Features/Account/`, which is the only thing outside this file
    /// that removes anything.
    ///
    /// It does **not** create the directory and does not report whether it
    /// exists: an absent vaults directory is a phone that never opened a vault,
    /// which is a different fact from one this call emptied.
    func vaultsDirectory() throws -> URL {
        try resolvedRoot().appendingPathComponent(Self.vaultsDirectoryName, isDirectory: true)
    }

    /// `<root>/vault/<vaultId>`, with the identifier checked before it becomes
    /// a path component.
    ///
    /// A vault identifier arrives from the core and ends up in a path. An empty
    /// one would silently resolve to the vaults directory itself, and `..` or a
    /// separator would escape it — both are the "an unparseable input reads as
    /// an empty one" failure, one layer down.
    private func vaultDirectory(_ vaultId: String) throws -> URL {
        guard !vaultId.isEmpty,
              vaultId != ".", vaultId != "..",
              !vaultId.contains("/"),
              !vaultId.contains("\0") else {
            throw Self.failure("the vault identifier is not a usable path component")
        }
        return try resolvedRoot()
            .appendingPathComponent(Self.vaultsDirectoryName, isDirectory: true)
            .appendingPathComponent(vaultId, isDirectory: true)
    }

    /// The two databases and every sidecar name they can have, in a fixed
    /// order. Named rather than enumerated from the directory: the list then
    /// says what is being protected, and an `images/` cache with thousands of
    /// files does not make every open pay for a directory walk.
    static func databaseFiles(in directory: URL) -> [URL] {
        [dataDatabaseName, indexDatabaseName].flatMap { database -> [URL] in
            [directory.appendingPathComponent(database)]
                + sidecarSuffixes.map { directory.appendingPathComponent(database + $0) }
        }
    }

    static func sidecars(of database: URL) -> [URL] {
        let directory = database.deletingLastPathComponent()
        return sidecarSuffixes.map { directory.appendingPathComponent(database.lastPathComponent + $0) }
    }

    private static func isDatabase(_ url: URL) -> Bool {
        url.lastPathComponent == dataDatabaseName || url.lastPathComponent == indexDatabaseName
    }

    // MARK: - Attributes

    /// Creates a directory if it is absent, then applies the class and the
    /// backup exclusion. Idempotent, and does not report a directory it could
    /// not confirm exists.
    private func harden(directory: URL) throws {
        if !attributes.isDirectory(at: directory) {
            do {
                try attributes.createDirectory(at: directory)
            } catch {
                throw Self.failure("could not create a directory", error)
            }
            guard attributes.isDirectory(at: directory) else {
                throw Self.failure("a directory reported as created is not there")
            }
        }
        try apply(.completeUntilFirstUserAuthentication, to: directory)
        try exclude(directory)
    }

    private func apply(_ protectionClass: ProtectionClass, to url: URL) throws {
        do {
            try attributes.setProtection(Self.attribute(for: protectionClass), at: url)
        } catch {
            throw Self.failure("could not set a protection class", error)
        }
    }

    private func exclude(_ url: URL) throws {
        guard attributes.exists(at: url) else {
            throw Self.failure("cannot exclude a path that does not exist from backup")
        }
        do {
            try attributes.setExcludedFromBackup(at: url)
        } catch {
            throw Self.failure("could not exclude a path from backup", error)
        }
        guard try readBackExclusion(url) == true else {
            throw Self.failure("a backup exclusion did not read back as set")
        }
    }

    private func readBackExclusion(_ url: URL) throws -> Bool? {
        do {
            return try attributes.excludedFromBackup(at: url)
        } catch {
            throw Self.failure("could not read a backup exclusion back", error)
        }
    }

    /// The whole mapping, exhaustive and with no `default:`, so a third class
    /// added in Rust is a compile error here rather than a silent fallback to
    /// the wrong one.
    ///
    /// `completeUntilFirstUserAuthentication` is the entitlement's own value
    /// (`Memry.entitlements`, `com.apple.developer.default-data-protection`).
    /// `complete` is a *different* class and is never what the databases use: a
    /// background refresh running before the first unlock after a reboot could
    /// not read them (data-model §A.0, research R11).
    static func attribute(for protectionClass: ProtectionClass) -> FileProtectionType {
        switch protectionClass {
        case .completeUntilFirstUserAuthentication: .completeUntilFirstUserAuthentication
        case .complete: .complete
        }
    }

    // MARK: - Failures

    /// A verb and, when there is an underlying `NSError`, a domain and a number.
    ///
    /// **No path ever.** A Foundation filesystem error stringifies with the
    /// full path in it, which carries the container identifier and the vault
    /// identifier, so the underlying error is reduced to its code rather than
    /// interpolated. The core already knows which path it asked about.
    private static func failure(_ what: String) -> StorageError {
        .Failed(what: what)
    }

    private static func failure(_ what: String, _ error: any Error) -> StorageError {
        let nsError = error as NSError
        return .Failed(what: "\(what) (\(nsError.domain) \(nsError.code))")
    }
}

/// The filesystem calls this seam makes, behind a protocol for one reason: a
/// real filesystem cannot be made to fail on demand, and the arms that matter
/// most here are the failures — a directory that cannot be created, an
/// exclusion that does not stick. "Could not tell" must not look like "fine",
/// and that is only testable if the platform can be told to lie.
///
/// Deliberately shaped like the platform rather than like a store, so a stub
/// substitutes Foundation and the logic under test is the real one.
protocol FileAttributes: Sendable {
    func exists(at url: URL) -> Bool
    func isDirectory(at url: URL) -> Bool
    func createDirectory(at url: URL) throws
    func setProtection(_ value: FileProtectionType, at url: URL) throws
    func setExcludedFromBackup(at url: URL) throws
    /// `nil` means the flag could not be read, which is never "excluded".
    func excludedFromBackup(at url: URL) throws -> Bool?
    /// `nil` means the capacity could not be read, which is never zero.
    func availableBytes(at url: URL) throws -> UInt64?
}

/// The real filesystem.
struct SystemFileAttributes: FileAttributes {
    func exists(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func isDirectory(at url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        let found = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        return found && isDirectory.boolValue
    }

    func createDirectory(at url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func setProtection(_ value: FileProtectionType, at url: URL) throws {
        try FileManager.default.setAttributes([.protectionKey: value], ofItemAtPath: url.path)
    }

    func setExcludedFromBackup(at url: URL) throws {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try target.setResourceValues(values)
    }

    func excludedFromBackup(at url: URL) throws -> Bool? {
        try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
    }

    func availableBytes(at url: URL) throws -> UInt64? {
        let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        guard let capacity = values.volumeAvailableCapacityForImportantUsage, capacity >= 0 else { return nil }
        return UInt64(capacity)
    }
}
