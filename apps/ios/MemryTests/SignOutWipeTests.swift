import Foundation
import MemryCore
import Security
import Synchronization
import Testing

@testable import Memry

// T159's evidence, and it is deliberately the **inverse** of the usual shape:
// the assertion is that **nothing remains**.
//
// An assertion that a remover "was called" passes with the removal deleted from
// the remover, and an assertion that a fake store "reported empty" passes with
// a fake that always did. So both halves are read back around this task's own
// abstractions:
//
//   * the filesystem through `FileManager` directly, over a **real** vault the
//     core itself created — `data.db`, `index.db`, the SQLite sidecars and
//     `images/` are files that exist because `Vault.open` made them, not names
//     this file invented;
//   * the keychain through raw `SecItem*`, at data-model §B's own identity, so
//     the read is the one another Memry client would make.
//
// **Every filesystem test lives inside its own temporary directory**, created
// and removed by the test. Nothing here touches a real vault directory and
// nothing makes a network call: the one test that drives the production graph
// stubs `URLProtocol` inside `URLSession`, before a connection exists.

/// Its own class and its own statics, so it cannot interleave with the other
/// `URLProtocol`s in this target.
private final class T159StubURLProtocol: URLProtocol, @unchecked Sendable {
    // swiftlint:disable static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    // swiftlint:enable static_over_final_class

    override func startLoading() {
        guard let url = request.url else { return }
        let response = HTTPURLResponse(
            url: url, statusCode: 400, httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )
        if let response {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(#"{"code":"VALIDATION_ERROR","message":"no"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func stubbedConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionTransport.defaultConfiguration()
    configuration.protocolClasses = [T159StubURLProtocol.self]
    return configuration
}

@Suite("T159 leaves nothing on the filesystem", .serialized)
struct VaultContentRemovalTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let vaultId = "t159-0123456789abcdef"
    private let second = "t159-fedcba9876543210"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t159-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
    }

    private var vaults: URL {
        root.appendingPathComponent(VaultFiles.vaultsDirectoryName, isDirectory: true)
    }

    private func directory(_ vaultId: String) -> URL {
        vaults.appendingPathComponent(vaultId, isDirectory: true)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// The downloaded image bytes data-model §A.0 puts in `images/`.
    private func imageFile(_ vaultId: String) -> URL {
        directory(vaultId)
            .appendingPathComponent(VaultFiles.imagesDirectoryName, isDirectory: true)
            .appendingPathComponent("chunk-0.bin")
    }

    /// A real vault, opened by the core through T144's seam, with an image
    /// beside it. Returns the handle so the caller decides whether the
    /// connection is still open.
    private func openVault(_ vaultId: String) async throws -> Vault {
        let opener = CoreVaultOpener(files: files, executor: CoreExecutor(label: "t159-wipe-tests"))
        let vault = try await opener.open(vaultId)
        try Data([0xDE, 0xAD, 0xBE, 0xEF]).write(to: imageFile(vaultId))
        return vault
    }

    /// **The assertion this task exists for.** Two real vaults, both databases,
    /// the images directory and the file in it — read back through
    /// `FileManager`, not through the remover that deleted them.
    @Test("after a sign-out no database, no image and no vault directory is left")
    func nothingRemains() async throws {
        var first: Vault? = try await openVault(vaultId)
        var other: Vault? = try await openVault(second)
        // A clean close, which is what a phone that has been sitting idle looks
        // like: `-wal` and `-shm` are gone and the two databases are not.
        first = nil
        other = nil
        // `data.db` and the image, for both vaults. **Not `index.db`**: this run
        // showed the core does not create it at open time, and asserting a file
        // the core never makes would have been a precondition that passed by
        // accident on the day it started to.
        for vaultId in [vaultId, second] {
            #expect(exists(directory(vaultId).appendingPathComponent(VaultFiles.dataDatabaseName)))
            #expect(exists(imageFile(vaultId)))
        }

        let removed = try VaultContentRemover(files: files).removeAllVaultContent()

        #expect(removed == 3, "two vault directories and the directory that held them")
        for vaultId in [vaultId, second] {
            #expect(!exists(directory(vaultId).appendingPathComponent(VaultFiles.dataDatabaseName)))
            #expect(!exists(directory(vaultId).appendingPathComponent(VaultFiles.indexDatabaseName)))
            #expect(!exists(imageFile(vaultId)))
            #expect(!exists(directory(vaultId).appendingPathComponent(VaultFiles.imagesDirectoryName)))
            #expect(!exists(directory(vaultId)))
        }
        #expect(!exists(vaults))
        // The container above it is the app's own and is **not** removed: the
        // next sign-in opens a vault under it, and `prepareVault` hardens it.
        #expect(exists(root))
        try? FileManager.default.removeItem(at: root)
    }

    /// The write-ahead log is the file that matters most and the one a
    /// three-named-files implementation would miss: it holds recent note text
    /// in plaintext and it only exists while a connection is open.
    @Test("a vault that is open right now loses its write-ahead log too")
    func theWriteAheadLogGoesAsWell() async throws {
        let vault = try await openVault(vaultId)
        let wal = directory(vaultId).appendingPathComponent("data.db-wal")
        #expect(exists(wal), "the open should have created a write-ahead log")

        try VaultContentRemover(files: files).removeAllVaultContent()

        #expect(!exists(wal))
        #expect(!exists(vaults))
        _ = vault.id()
        try? FileManager.default.removeItem(at: root)
    }

    /// "The directory is missing" is not "the directory was deleted by me", and
    /// it is not a failure either: a phone that signed in and never opened a
    /// vault has no vaults directory, and so does a phone whose sign-out has
    /// already completed. Both must be able to run this.
    @Test("removing nothing is not a failure and is not a deletion")
    func removingNothingSucceeds() throws {
        let removed = try VaultContentRemover(files: files).removeAllVaultContent()

        #expect(removed == 0)
        #expect(!exists(vaults))
    }

    /// A removal that reported success and did not take must not return as if
    /// it had. This is `Keychain.delete`'s rule one layer over: a delete that
    /// silently failed leaves note content on a phone the user believes was
    /// wiped.
    @Test("a removal that did not take is reported, not believed")
    func aRemovalThatDidNotTakeIsReported() async throws {
        var vault: Vault? = try await openVault(vaultId)
        vault = nil

        let remover = VaultContentRemover(files: files, filesystem: LyingFilesystem())

        #expect(throws: StorageError.self) { try remover.removeAllVaultContent() }
        // And it really did not take: the databases are still there.
        #expect(exists(directory(vaultId).appendingPathComponent(VaultFiles.dataDatabaseName)))
        try? FileManager.default.removeItem(at: root)
    }

    /// A directory that exists and cannot be listed is **not an empty one**.
    /// Treating the listing as `[]` would report a sign-out that removed
    /// nothing as one that found nothing to remove.
    @Test("a directory that cannot be listed is not an empty one")
    func anUnlistableDirectoryIsNotEmpty() async throws {
        var vault: Vault? = try await openVault(vaultId)
        vault = nil

        let remover = VaultContentRemover(files: files, filesystem: UnlistableFilesystem())

        #expect(throws: StorageError.self) { try remover.removeAllVaultContent() }
        try? FileManager.default.removeItem(at: root)
    }
}

/// Every removal "succeeds" and nothing is removed.
private struct LyingFilesystem: VaultContentFiles {
    private let real = SystemVaultContentFiles()
    func exists(at url: URL) -> Bool { real.exists(at: url) }
    func contentsOfDirectory(at url: URL) throws -> [URL] { try real.contentsOfDirectory(at: url) }
    func removeItem(at url: URL) throws {}
}

/// The directory is there and cannot be read.
private struct UnlistableFilesystem: VaultContentFiles {
    private let real = SystemVaultContentFiles()
    func exists(at url: URL) -> Bool { real.exists(at: url) }
    func removeItem(at url: URL) throws { try real.removeItem(at: url) }
    func contentsOfDirectory(at url: URL) throws -> [URL] {
        throw CocoaError(.fileReadNoPermission)
    }
}

// MARK: - The keychain, for real

extension RealKeychainSuite {
    @Suite("T159 leaves nothing in the keychain", .serialized)
    struct SignOutKeychainTests {
        /// **The whole production chain, and the read is a raw `SecItem*`.**
        ///
        /// `AuthComposition` → the genuine `AuthSession` → the genuine `Keychain` →
        /// `SecItemDelete`, driven by `SignOutService` exactly as `AuthStartup`
        /// builds it. The session is brought to `Registered` by chapter 02 §2.14's
        /// `restore()`, which reads the refresh token this test planted — no
        /// request, and none is made: the `URLProtocol` above answers the
        /// best-effort logout without a connection existing.
        ///
        /// Swap the real `Keychain` for a working in-memory `SecureStore` and every
        /// read below still answers "absent" — which is why the planting is done
        /// with raw `SecItem*` too. What is asserted is the state of the **system**
        /// keychain, not of anything this task wrote.
        @Test("every one of data-model §B's five entries is gone afterwards")
        @MainActor
        func noKeychainEntryRemains() async throws {
            // The write's own status, not a read-back: a read-back is racy against
            // the sibling suite, and `errSecSuccess` here is what rules out the
            // vacuous pass — an unsigned build answers `errSecMissingEntitlement`
            // (-34018) to every `SecItem*` call (defect 115), and then "the marker
            // is not there afterwards" would be true because it was never there.
            for account in Self.accounts {
                #expect(plant(account) == errSecSuccess, "the test could not plant \(account)")
            }
            let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
                .appendingPathComponent("t159-keychain-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: root) }

            let events = CoreEvents()
            let session = try AuthComposition.makeSession(
                environment: .staging,
                device: AuthComposition.device(appVersion: "0.1.0+t159"),
                emitter: events.emitter,
                transportConfiguration: stubbedConfiguration(),
                keychainItems: SystemKeychainItemStore()
            )
            // The planted refresh token is a session to restore (§2.14), and
            // `sign_out` is an edge only out of `Registered`.
            let restored = try session.restore()
            #expect(restored == .registered)

            let service = SignOutService(
                session: session,
                content: VaultContentRemover(files: VaultFiles(emitter: events.emitter, root: root)),
                executor: CoreExecutor(label: "t159-keychain-tests")
            )
            let wipe = try await service.signOut()

            #expect(wipe.state == .signedOut)
            #expect(wipe.isComplete)
            // **Nothing is left under §B's five identities**, and the bytes this
            // test planted are among the things not left.
            //
            // The absence form used to be unsafe here and now is not, which is
            // the whole of spec-defect 131: `KeychainRealStoreTests` writes these
            // same five production identities (data-model §B fixes the names),
            // Swift Testing runs sibling suites concurrently, and a full-plan run
            // caught a **32-byte** value where this test had planted 14 — the
            // other suite's master key, not a sign-out that failed. Both suites
            // now nest inside `RealKeychainSuite`, whose `.serialized` is
            // inherited, so no other test touches this store while this one runs
            // and absence means the sign-out deleted it.
            //
            // Both assertions stay. The marker check fails if the deletion is
            // removed even were the serialisation ever lost; the absence check is
            // the one that means what §B says.
            for account in Self.accounts {
                #expect(raw(account) != planted(account), "\(account) survived the sign-out")
                #expect(raw(account) == nil, "\(account) is still in the keychain")
            }
        }

        /// data-model §B, verbatim. Not derived from `Keychain`'s own table: a
        /// rename there would then rename the thing being asserted, and these
        /// strings are the cross-client contract.
        private static let accounts = [
            "master-key", "device-signing-key", "access-token", "refresh-token", "setup-token"
        ]

        private func identity(_ account: String) -> [String: Any] {
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Keychain.service,
                kSecAttrAccount as String: account,
                kSecUseDataProtectionKeychain as String: true,
                kSecAttrSynchronizable as String: false
            ]
        }

        /// The marker this test writes, distinct from anything the core or another
        /// suite would store.
        private func planted(_ account: String) -> Data {
            Data("t159-\(account)".utf8)
        }

        @discardableResult
        private func plant(_ account: String) -> OSStatus {
            SecItemDelete(identity(account) as CFDictionary)
            var attributes = identity(account)
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            attributes[kSecValueData as String] = planted(account)
            return SecItemAdd(attributes as CFDictionary, nil)
        }

        /// `SecItemCopyMatching`, around every abstraction this task owns.
        private func raw(_ account: String) -> Data? {
            var query = identity(account)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
            return result as? Data
        }
    }
}

// MARK: - The wiring

@Suite("T159 wiring", .serialized)
struct SignOutWiringTests {
    /// **The production call site, asserted at the production entry point.**
    /// `AuthStartup` is what `AuthRootView` builds; nothing here is a
    /// reconstruction of it.
    ///
    /// Two facts, and both are needed: the session the rest of the app is
    /// handed is the **watched** one, so FR-026's detection covers every
    /// authenticated call rather than one screen; and the account model exists,
    /// so FR-025 has an affordance at all. Phase 3 shipped five tiers that were
    /// implemented, tested and never called — this is the assertion that would
    /// have failed for them.
    ///
    /// It drives no destruction: the wipe would run against the production
    /// vault directory, and nothing in this target may touch one.
    @Test("the launch hands the app a watched session and an account model")
    @MainActor
    func theProductionLaunchIsWatched() async throws {
        let items = SeededKeychainItems(seed: ["refresh-token": "refresh-from-the-last-run"])
        let startup = AuthStartup(transportConfiguration: stubbedConfiguration(), keychainItems: items)

        await startup.begin()

        guard case let .ready(model) = startup.phase else {
            Issue.record("the app root did not reach the core: \(startup.phase)")
            return
        }
        #expect(model.state == .registered)
        // The watch, not the bare session: a `CoreVaultRegistry` built over the
        // unwatched one would meet a revocation and render "its copy of your
        // vault has been removed" with nothing removed.
        #expect(startup.session is RevocationWatch)
        #expect(startup.account != nil)
    }
}
