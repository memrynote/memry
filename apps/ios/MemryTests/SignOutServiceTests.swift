import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T159. The order of the destruction, and the two half-completed states.
//
// **What these assert is what is left, not what was called.** A test that says
// "the remover was invoked" passes with the removal deleted from the remover,
// which is the failure mode this whole task is about. So the fakes here are
// **working** ones — a store that really holds entries and really loses them, a
// recorder that really orders the two halves — and the assertions are over
// their state afterwards. `SignOutWipeTests` does the same thing against the
// real keychain and the real filesystem.

// MARK: - A core that can be made to refuse

/// Scripted `signOut` / `markRevoked`, recording into a shared order log.
///
/// Everything else traps. A fake that answered a call no test wrote down is the
/// shape that let five bugs through this phase.
private final class ScriptedSession: AuthSessionProtocol, @unchecked Sendable {
    private let log: OrderLog
    private let signOutResult: Result<AuthState, any Error>
    private let revokeResult: Result<AuthState, any Error>

    init(
        log: OrderLog,
        signOut: Result<AuthState, any Error> = .success(AuthState.signedOut),
        revoke: Result<AuthState, any Error> = .success(AuthState.revoked)
    ) {
        self.log = log
        signOutResult = signOut
        revokeResult = revoke
    }

    func signOut() async throws -> AuthState {
        log.record("keychain")
        return try signOutResult.get()
    }

    func markRevoked() throws -> AuthState {
        log.record("keychain")
        return try revokeResult.get()
    }

    func state() -> AuthState { .registered }
    func keyMaterial() async throws -> KeyMaterial { throw Untold() }
    func vaults() async throws -> [VaultSummary] { throw Untold() }
    func refresh() async throws -> AuthState { throw Untold() }
    func registerDevice() async throws -> AuthState { throw Untold() }
    func renewSetupToken() async throws -> AuthState { throw Untold() }
    func requestEmailCode(email: String) async throws -> AuthState { throw Untold() }
    func resendEmailCode() async throws { throw Untold() }
    func restore() throws -> AuthState { throw Untold() }
    func verifyEmailCode(code: String) async throws -> AuthState { throw Untold() }
    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState { throw Untold() }
    func abandonProviderSignIn() throws -> AuthState { throw Untold() }
    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome { throw Untold() }
}

private struct Untold: Error {}

/// Which half of the destruction ran, in order.
///
/// A class around the `Mutex` rather than the `Mutex` itself: `Mutex` is
/// noncopyable, so it cannot be handed to two objects as a parameter.
private final class OrderLog: Sendable {
    private let entries = Mutex<[String]>([])

    func record(_ half: String) { entries.withLock { $0.append(half) } }
    var order: [String] { entries.withLock { $0 } }
}

/// A remover that records into the same log and can be made to fail.
///
/// A class rather than a struct only because `any Error` is not `Sendable` and
/// `VaultContentRemoval` is.
private final class ScriptedContent: VaultContentRemoval, @unchecked Sendable {
    private let log: OrderLog
    private let failure: (any Error)?

    init(log: OrderLog, failure: (any Error)? = nil) {
        self.log = log
        self.failure = failure
    }

    @discardableResult
    func removeAllVaultContent() throws -> Int {
        log.record("files")
        if let failure { throw failure }
        return 2
    }
}

private func executor() -> CoreExecutor { CoreExecutor(label: "t159-service-tests") }

@Suite("T159 sign-out ordering and half-completed states")
struct SignOutServiceTests {
    /// **The order.** The keys are what makes everything else reachable —
    /// chapter 01 §1.7 derives every vault key from the master key and the two
    /// tokens re-download the account — so the keychain goes first and the
    /// files follow. Reversed, a failure between the two leaves a phone with
    /// no notes and a working session.
    @Test("the five keychain entries go before the files, never after")
    func keysGoBeforeFiles() async throws {
        let log = OrderLog()
        let service = SignOutService(
            session: ScriptedSession(log: log),
            content: ScriptedContent(log: log),
            executor: executor()
        )

        let wipe = try await service.signOut()

        #expect(log.order == ["keychain", "files"])
        #expect(wipe.reason == .signedOutByUser)
        #expect(wipe.state == .signedOut)
        #expect(wipe.isComplete)
    }

    /// The locked-keychain case, and the reason the order is what it is: a
    /// phone that has not been unlocked since boot reads `Locked`, not
    /// "absent" (`Keychain`'s header, chapter 02 §2.14). Nothing may be
    /// destroyed for a refusal that will pass.
    @Test("a core call that refuses removes nothing at all")
    func aRefusedCoreCallRemovesNothing() async throws {
        let log = OrderLog()
        let service = SignOutService(
            session: ScriptedSession(log: log, signOut: .failure(SecureStoreError.Locked)),
            content: ScriptedContent(log: log),
            executor: executor()
        )

        await #expect(throws: SecureStoreError.self) { try await service.signOut() }

        // The keychain attempt happened; the filesystem never did.
        #expect(log.order == ["keychain"])
    }

    /// The other half: the keys are gone, so the user **is** signed out, and
    /// saying otherwise would invite them to retry something that already
    /// happened. The residue is a notice beside a completed sign-out.
    @Test("files that survive still leave the user signed out, with a notice")
    func filesThatSurviveAreReportedButDoNotUndoTheSignOut() async throws {
        let log = OrderLog()
        let service = SignOutService(
            session: ScriptedSession(log: log),
            content: ScriptedContent(log: log, failure: StorageError.Failed(what: "no")),
            executor: executor()
        )

        let wipe = try await service.signOut()

        #expect(wipe.state == .signedOut)
        #expect(!wipe.isComplete)
        #expect(wipe.residue == AccountCopy.contentSurvived)
        // Not the mapped `StorageError` sentence: "close Memry and open it
        // again" describes a database this app is still trying to use.
        #expect(wipe.residue?.code != "storage.failed")
        // And it offers the retry that genuinely exists.
        #expect(wipe.residue?.recourse == .retry)
    }

    /// FR-026's half. `mark_revoked` is **blocking** (spec-defect 90) and its
    /// content removal is on the other side of the value the revoked screen is
    /// built from, which is what makes data-model §C.1's "removed **before**
    /// this is shown" structural rather than remembered.
    @Test("a revocation removes the same things and says why")
    func aRevocationRemovesTheSameThings() async throws {
        let log = OrderLog()
        let service = SignOutService(
            session: ScriptedSession(log: log),
            content: ScriptedContent(log: log),
            executor: executor()
        )

        let wipe = try await service.markRevoked()

        #expect(log.order == ["keychain", "files"])
        #expect(wipe.reason == .deviceRevoked)
        #expect(wipe.state == .revoked)
        #expect(wipe.isComplete)
    }

    /// A revocation that could not run its destruction must not produce the
    /// revoked screen: that screen's copy says the vault copy has been removed,
    /// and `DESIGN.md` requires the sentence to be true wherever it is read.
    @Test("a revocation whose keychain half fails produces no revoked screen")
    func aRefusedRevocationProducesNothingToRender() async throws {
        let log = OrderLog()
        let service = SignOutService(
            session: ScriptedSession(log: log, revoke: .failure(SecureStoreError.Locked)),
            content: ScriptedContent(log: log),
            executor: executor()
        )

        await #expect(throws: SecureStoreError.self) { try await service.markRevoked() }

        #expect(log.order == ["keychain"])
    }
}

// MARK: - Detection

@Suite("T159 revocation detection")
struct RevocationWatchTests {
    /// **The classifier is the dangerous part, not the deletion.** Too wide and
    /// a 503 wipes a working install; too narrow and a revoked phone keeps
    /// showing a vault it was told had gone.
    @Test("only the two shapes the core can deliver a revocation in are one")
    func onlyARealRevocationCounts() {
        #expect(RevocationSignal.isRevocation(ApiError.DeviceRevoked(message: "revoked")))
        #expect(RevocationSignal.isRevocation(AuthError.Api(source: ApiError.DeviceRevoked(message: "revoked"))))

        #expect(!RevocationSignal.isRevocation(ApiError.Unauthorized(code: "AUTH_INVALID_TOKEN", message: "no")))
        #expect(!RevocationSignal.isRevocation(ApiError.RateLimited(retryAfterS: 60, message: "slow down")))
        #expect(!RevocationSignal.isRevocation(AuthError.SessionExpired))
        #expect(!RevocationSignal.isRevocation(SecureStoreError.Locked))
        #expect(!RevocationSignal.isRevocation(StorageError.Failed(what: "disk")))
        #expect(!RevocationSignal.isRevocation(CancellationError()))
    }

    /// FR-026, and the reason the watch awaits its handler: the content is gone
    /// **before** the caller's error handling runs, so the screen that renders
    /// `api.deviceRevoked` — "its copy of your vault has been removed" — is not
    /// making a claim about work that has not happened.
    @Test("a revocation wipes this device before the error reaches the caller")
    func theWipeHappensBeforeTheErrorIsRethrown() async throws {
        let wiped = Flag()
        let watch = RevocationWatch(session: RevokingSession()) {
            wiped.raise()
            return true
        }

        await #expect(throws: ApiError.self) { try await watch.vaults() }

        #expect(wiped.isRaised)
    }

    /// **The break that matters most.** Every other failure a phone meets is
    /// one of these, and a matcher that answered `true` for any of them would
    /// destroy a working install on a dropped connection.
    @Test("an ordinary failure deletes nothing")
    func anOrdinaryFailureDeletesNothing() async throws {
        let wiped = Flag()
        let refusal = ApiError.Unauthorized(code: "AUTH_INVALID_TOKEN", message: "no")
        let watch = RevocationWatch(session: RevokingSession(error: refusal)) {
            wiped.raise()
            return true
        }

        await #expect(throws: ApiError.self) { try await watch.vaults() }

        #expect(!wiped.isRaised)
    }

    /// Chapter 02 §2.10 records fifteen demand-driven callers meeting one dead
    /// token. Fifteen racing deletions of one directory would mostly report a
    /// failure meaning "somebody else already did this".
    @Test("many calls meeting one revocation wipe once")
    func oneWipePerRevocation() async throws {
        let wipes = Counter()
        let watch = RevocationWatch(session: RevokingSession()) {
            wipes.increment()
            return true
        }

        _ = try? await watch.vaults()
        _ = try? await watch.keyMaterial()
        _ = try? await watch.refresh()

        #expect(wipes.count == 1)
    }

    /// A destruction that could not run is not "handled". Latching on it would
    /// leave a revoked phone holding its vault until it was relaunched, and the
    /// failure it latched on — a locked keychain — passes by itself.
    @Test("a wipe that did not run is retried on the next refusal")
    func aFailedWipeDoesNotLatch() async throws {
        let attempts = Counter()
        let watch = RevocationWatch(session: RevokingSession()) {
            attempts.increment()
            return false
        }

        _ = try? await watch.vaults()
        _ = try? await watch.vaults()

        #expect(attempts.count == 2)
    }

    /// The watch decides nothing about what the user sees: `ErrorMapping` is
    /// still the only place a sentence is made (Constitution II).
    @Test("the original error is rethrown unchanged")
    func theErrorIsRethrownUnchanged() async throws {
        let watch = RevocationWatch(session: RevokingSession()) { true }

        var raised: (any Error)?
        do {
            _ = try await watch.vaults()
        } catch {
            raised = error
        }

        let mapped = ErrorMapping.userFacing(try #require(raised))
        #expect(mapped.code == "api.deviceRevoked")
    }
}

@Suite("T159 what the account shell puts around the app")
struct AccountPresentationTests {
    /// The revoked screen replaces the app, from the one state it belongs to.
    @Test("revoked replaces everything, and nothing else does")
    func revokedReplacesTheScreen() {
        #expect(AccountPresentation.of(state: .revoked, hasNotice: false) == .revoked)
        #expect(AccountPresentation.of(state: .registered, hasNotice: false) != .revoked)
    }

    /// Offered only where `sign_out` is an edge (`api/auth.rs`'s table).
    /// Anywhere else the one possible answer is `auth.invalidState`, which tells
    /// the user nothing they did wrong.
    @Test("the way out is offered from the two states the core accepts it from")
    func theWayOutIsOfferedWhereItWorks() {
        #expect(AccountPresentation.of(state: .registered, hasNotice: false) == .wayOut)
        #expect(AccountPresentation.of(state: .sessionExpired, hasNotice: false) == .wayOut)

        #expect(AccountPresentation.of(state: .signedOut, hasNotice: false) == .plain)
        #expect(AccountPresentation.of(state: .setupPending, hasNotice: false) == .plain)
        #expect(AccountPresentation.of(state: .setupExpired, hasNotice: false) == .plain)
        #expect(AccountPresentation.of(state: .awaitingOtp(email: "a@b.c"), hasNotice: false) == .plain)
    }

    /// **The notice that would otherwise be rendered nowhere.** A sign-out that
    /// left content behind ends in `SignedOut`, which is exactly the state where
    /// the control is not offered — so a shell keyed only on "can sign out"
    /// would swallow the one sentence that says part of the copy survived.
    @Test("a notice survives into the state the sign-out left the user in")
    func aNoticeOutlivesTheStateThatProducedIt() {
        #expect(AccountPresentation.of(state: .signedOut, hasNotice: true) == .noticeOnly)
        #expect(AccountPresentation.of(state: .signedOut, hasNotice: false) == .plain)
    }
}

/// One bit and one count, shared with a `@Sendable` closure. Same reason as
/// ``OrderLog``: a `Mutex` cannot be captured across one.
private final class Flag: Sendable {
    private let value = Mutex<Bool>(false)
    func raise() { value.withLock { $0 = true } }
    var isRaised: Bool { value.withLock { $0 } }
}

private final class Counter: Sendable {
    private let value = Mutex<Int>(0)
    func increment() { value.withLock { $0 += 1 } }
    var count: Int { value.withLock { $0 } }
}

/// A session whose every network call fails the same way.
private final class RevokingSession: AuthSessionProtocol, @unchecked Sendable {
    private let error: any Error

    init(error: any Error = ApiError.DeviceRevoked(message: "revoked")) {
        self.error = error
    }

    func vaults() async throws -> [VaultSummary] { throw error }
    func keyMaterial() async throws -> KeyMaterial { throw error }
    func refresh() async throws -> AuthState { throw error }

    func state() -> AuthState { .registered }
    func markRevoked() throws -> AuthState { .revoked }
    func signOut() async throws -> AuthState { .signedOut }
    func registerDevice() async throws -> AuthState { throw error }
    func renewSetupToken() async throws -> AuthState { throw error }
    func requestEmailCode(email: String) async throws -> AuthState { throw error }
    func resendEmailCode() async throws { throw error }
    func restore() throws -> AuthState { .registered }
    func verifyEmailCode(code: String) async throws -> AuthState { throw error }
    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState { throw error }
    func abandonProviderSignIn() throws -> AuthState { throw error }
    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome { throw error }
}
