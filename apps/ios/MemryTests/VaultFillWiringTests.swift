import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T237, the half that matters most: **is the fill screen driving the core, or
// something that behaves like it?**
//
// Nothing below substitutes `VaultSync`. A real vault database is created in a
// temporary directory by the production `CoreVaultOpener`, a real `AuthSession`
// is built by the production `AuthComposition` over the real `Keychain` and the
// real `URLSessionTransport`, and `CoreVaultFillerMint` mints a real
// `VaultSync` over both. Only the two platforms underneath are substituted:
// `SecItem*` and `URLSession`'s protocol stack.
//
// **No network call is made by this file, and every test asserts it.** The
// stub `URLProtocol` records every request it is handed and the suite expects
// zero. That is not incidental — it is the assertion for the entry gate, which
// exists precisely so that a shell can decide whether to show a setting-up
// screen without going near the network.
//
// The two real-core failures driven here are the two that need no request at
// all, which is what makes them hermetic:
//
//   * `firstSync` over a keychain holding no master key throws
//     `SyncError.Locked` before it builds a cipher, so it never reaches
//     `device_directory`.
//   * `fetchNoteBody` for a note the vault holds no live record of is refused
//     with `SyncError.UnknownNote` by a local read, before any pull.
//
// **No staging path is read and no real account is touched.**

/// Records every request and answers none of them. A request reaching here is
/// a failure of the test, not a fixture.
class NoRequestURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static let seen = Mutex<[URL]>([])

    static func reset() { seen.withLock { $0 = [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url { Self.seen.withLock { $0.append(url) } }
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
}

@MainActor
@Suite("T237 the fill wiring", .serialized)
final class VaultFillWiringTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let opener: CoreVaultOpener
    private let executor = CoreExecutor(label: "t237-tests")
    private let vaultId = "t237-0123456789abcdef"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("t237-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
        opener = CoreVaultOpener(files: files, executor: executor)
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionTransport.defaultConfiguration()
        configuration.protocolClasses = [NoRequestURLProtocol.self]
        return configuration
    }

    /// The production session, over the real seams with both platforms
    /// substituted — the same shape `SignInWiringTests` uses.
    private func session() throws -> AuthSession {
        try AuthComposition.makeSession(
            environment: .staging,
            device: AuthComposition.device(appVersion: "0.1.0+t237"),
            emitter: hub.emitter,
            transportConfiguration: Self.configuration(),
            keychainItems: RecordingKeychainItems()
        )
    }

    /// **Spec-defect 136, reproduced over the real core, and then gated.**
    ///
    /// A genuinely empty vault: the production opener creates `data.db`, the
    /// production `CoreNotesReader` crosses the real FFI to read it, and the
    /// answer is nothing — because nothing has filled it. The gate then says
    /// so without making a request, which is the whole point of its existing.
    @Test("a real empty vault reads as empty, and the gate says so with no request")
    func aRealEmptyVaultIsGatedWithoutARequest() async throws {
        NoRequestURLProtocol.reset()
        let vault = try await opener.open(vaultId)

        // Nothing in the read path fills anything. This is the defect.
        let browse = VaultBrowseViewModel(vault: vault, executor: executor)
        await browse.loadIfNeeded()
        #expect(browse.phase == .empty)

        // The production mint, over a real `AuthSession`.
        let filler = try await CoreVaultFillerMint(session: session(), executor: executor)
            .filler(for: vault)
        // A working fake would answer `false` too, which is exactly why the
        // type is asserted as well.
        #expect(filler is CoreVaultFiller)
        #expect(try await filler.isFirstSyncComplete() == false)

        // And it asked nobody. `isFirstSyncComplete()` is one row of the local
        // `meta` table; a version of it that fell back to the network would
        // put a URL in here.
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }

    /// The production chain end to end over the real core, with the one core
    /// failure that needs no request: no master key, so no vault key, so
    /// `SyncError.Locked` before a cipher is even built.
    ///
    /// **Two things are proved at once.** That `VaultFillViewModel` really
    /// reaches `VaultSync.firstSync` — a fake could not produce this error —
    /// and that `ErrorMapping` covers `SyncError`, because an uncovered enum
    /// would land on `shell.unrecognised` here exactly as `LinkingError` did.
    @Test("the production fill reaches the real core, and its failure is a mapped SyncError")
    func theProductionFillReachesTheCore() async throws {
        NoRequestURLProtocol.reset()
        let vault = try await opener.open(vaultId)
        let filler = try await CoreVaultFillerMint(session: session(), executor: executor)
            .filler(for: vault)

        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()

        guard case let .failed(error) = fill.phase else {
            Issue.record("a first sync with no master key did not fail")
            return
        }
        #expect(error.code == ErrorMapping.locked.code)
        #expect(error.code != ErrorMapping.unrecognised.code)

        // The vault is still readable, and still honestly empty rather than
        // broken. A failed pull destroys nothing.
        let browse = VaultBrowseViewModel(vault: vault, executor: executor)
        await browse.loadIfNeeded()
        #expect(browse.phase == .empty)
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }

    /// `SyncError.UnknownNote` over the real core: the liveness check is a
    /// local read, so the refusal happens before any pull.
    ///
    /// **It is permanent, and the copy must never call it retryable**
    /// (chapter 07 §7.15: the server still answers with a deleted document's
    /// surviving log, and applying it would resurrect body state for a note
    /// the record feed says is gone).
    @Test("a body fetch for a note this vault has no record of is permanently refused")
    func anUnknownNoteIsPermanentlyRefused() async throws {
        NoRequestURLProtocol.reset()
        let vault = try await opener.open(vaultId)
        let filler = try await CoreVaultFillerMint(session: session(), executor: executor)
            .filler(for: vault)

        await #expect(throws: SyncError.self) {
            _ = try await filler.fetchNoteBody(noteId: "no-such-note")
        }

        let mapped = ErrorMapping.userFacing(SyncError.UnknownNote(id: "no-such-note"))
        #expect(mapped.recourse == .blocked)
        #expect(mapped.code != ErrorMapping.unrecognised.code)
        // No note id in anything a user can see (Constitution II).
        #expect(!mapped.text.contains("no-such-note"))
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }

    /// **The top of the chain.** `AuthRootView` -> `AuthStartup.begin()` ->
    /// `vaultModel(for:)` is where the mint is handed over, and it is the one
    /// link a screen test cannot see. The real composition runs here, over the
    /// real `Keychain` and the real `URLSessionTransport`.
    @Test("the composition root hands the vault screen the core mint")
    func theCompositionRootHandsOverTheMint() async throws {
        NoRequestURLProtocol.reset()
        let startup = AuthStartup(
            emitter: CoreEvents().emitter,
            transportConfiguration: Self.configuration(),
            keychainItems: RecordingKeychainItems()
        )
        await startup.begin()

        // T237 added this: `Vault.sync(session:)` needs the concrete session,
        // and without it `vaultModel` can mint nothing.
        #expect(startup.coreSession != nil)
        let model = try #require(startup.vaultModel(for: .registered))
        #expect(model.mint is CoreVaultFillerMint)
        // A launch makes no request of its own (spec-defect 121: `restore()`
        // reads the keychain and nothing else).
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }

    /// **The production vault screen carries the production filler.**
    ///
    /// This is the one assertion that would have caught spec-defect 136 being
    /// re-shipped: a `VaultSelectionViewModel` that opens a vault and mints
    /// nothing hands the browse screen a database nobody fills. It is asserted
    /// on the concrete type, so a working fake fails it.
    @Test("an opened vault carries the core filler with it")
    func anOpenedVaultCarriesTheCoreFiller() async throws {
        NoRequestURLProtocol.reset()
        let model = VaultSelectionViewModel(
            registry: OneVault(id: vaultId),
            opener: opener,
            mint: try CoreVaultFillerMint(session: session(), executor: executor)
        )
        await model.load()

        #expect(model.vault != nil)
        #expect(model.filler is CoreVaultFiller)
        // A single-vault account is opened without asking, and opening it
        // makes no request either.
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }
}

/// An account holding exactly one vault, so the screen opens it without asking.
private struct OneVault: VaultRegistry {
    let id: String

    func vaults() async throws -> [VaultSummary] {
        [VaultSummary(id: id, name: "the one vault")]
    }
}

// MARK: - `ErrorMapping` covers `SyncError`

@Suite("T237 SyncError copy")
struct ErrorMappingSyncTests {
    /// Every one of the eight variants, and none of them reaches the
    /// unrecognised arm. `LinkingError` shipped uncovered and fell through to
    /// it until somebody noticed; this is the test that would have caught it.
    @Test("every SyncError variant has copy of its own")
    func everyVariantIsCovered() {
        let cases: [SyncError] = [
            .Api(source: .Unauthorized(code: "", message: "")),
            .Storage(source: .NotOpen),
            .SecureStore(source: .Locked),
            .Crypto(source: .DecryptionFailed),
            .Locked,
            .UnknownNote(id: "n"),
            .AttachmentUnverified(deviceId: "device-a"),
            .AttachmentCorrupt(what: "chunk 2 failed its hash")
        ]
        for error in cases {
            // Through the funnel a `catch` block actually uses, not the
            // overload — that is where `LinkingError` fell through.
            let mapped = ErrorMapping.userFacing(error as any Error)
            #expect(mapped.code != ErrorMapping.unrecognised.code, "\(error)")
            #expect(!mapped.title.isEmpty)
        }
    }

    /// The four nested arms forward rather than inventing a second sentence
    /// for the same fact.
    @Test("a nested error keeps the copy it already had")
    func nestedErrorsForward() {
        #expect(
            ErrorMapping.userFacing(SyncError.Api(source: .Unauthorized(code: "", message: ""))).code
                == ErrorMapping.userFacing(ApiError.Unauthorized(code: "", message: "")).code
        )
        #expect(
            ErrorMapping.userFacing(SyncError.SecureStore(source: .Locked)).code
                == ErrorMapping.userFacing(SecureStoreError.Locked).code
        )
    }

    /// **A sentence must be true on every screen that can show it.**
    /// `UnknownNote` is a permanent refusal and `Locked` is fixed elsewhere,
    /// so neither may be described as something to repeat.
    @Test("neither permanent refusal is described as retryable")
    func permanentRefusalsAreNotRetryable() {
        #expect(ErrorMapping.userFacing(SyncError.UnknownNote(id: "n")).recourse == .blocked)
        #expect(ErrorMapping.userFacing(SyncError.Locked).recourse == .blocked)
        for copy in [ErrorMapping.unknownNote, ErrorMapping.locked] {
            #expect(!copy.text.lowercased().contains("try again"))
        }
    }

    /// The distinction chapter 14 §14.4.1 rests on, and the reason the two
    /// attachment failures are separate variants rather than one.
    ///
    /// A manifest that will not verify means the server may be offering
    /// somebody else's bytes for this note's picture, and repeating the fetch
    /// gets the same unverifiable manifest. Bytes that failed their hash mean
    /// the manifest was trustworthy and the transfer was not, which is worth
    /// trying again. A shell offering "try again" for the first would be
    /// inviting the user to re-run an attack.
    @Test("an unverifiable manifest is blocked and corrupt bytes are retryable")
    func theTwoAttachmentFailuresOfferDifferentRecourse() {
        #expect(
            ErrorMapping.userFacing(SyncError.AttachmentUnverified(deviceId: "d")).recourse
                == .blocked
        )
        #expect(
            ErrorMapping.userFacing(SyncError.AttachmentCorrupt(what: "checksum")).recourse
                == .retry
        )
    }

    /// Constitution II. A device id identifies a user's hardware and a note id
    /// identifies content; a string that reaches an alert can reach a
    /// screenshot.
    @Test("no attachment sentence echoes the payload it was given")
    func attachmentCopyEchoesNoPayload() {
        let unverified = ErrorMapping.userFacing(
            SyncError.AttachmentUnverified(deviceId: "device-secret")
        )
        let corrupt = ErrorMapping.userFacing(SyncError.AttachmentCorrupt(what: "chunk-secret"))
        #expect(!unverified.text.contains("device-secret"))
        #expect(!corrupt.text.contains("chunk-secret"))
    }
}
