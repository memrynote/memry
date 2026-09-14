import Foundation
import MemryCore

// T159. Sign-out (FR-025) and revocation (FR-026), which are the same
// destruction reached two ways and must not be the same *state* afterwards.
//
// **Everything here removes is unrecoverable on this device.** So the two
// things this file is actually about are the **order** and what a
// half-completed run leaves the user in. Neither is an edge case.
//
// ## The order: keys first, files second
//
// The core does the keychain half itself — `sign_out` and `mark_revoked` both
// call `SecureStore::clear`, which is `Keychain.clear()` over data-model §B's
// five entries — and it does it **before** it returns a state. So the order is
// not a preference here, it is a consequence of which call is made first, and
// this file makes the core call first on purpose:
//
//   * The master key is what makes everything else readable **that is not
//     already on this phone**: chapter 01 §1.7 derives every vault key from it,
//     and the two tokens re-download the account. Removing the databases while
//     the keys stay is removing the copy and keeping the means to fetch it
//     again. Removing the keys while a database survives leaves content this
//     app can no longer open, on a phone that is genuinely signed out.
//   * The keychain half is the half that can fail for a reason that will pass:
//     `errSecInteractionNotAllowed` is a phone that has not been unlocked since
//     boot (`Keychain`'s header, spec-defect 121). Attempting it first means a
//     locked store costs the user nothing — nothing has been deleted, they are
//     still signed in, and the retry is real.
//   * `Revoked` must not reach the screen before the content is gone
//     (data-model §C.1: "local vault content is removed **before** this is
//     shown, not after"), and `ErrorMapping`'s sentence for it already says
//     "its copy of your vault has been removed". A sentence must be true on
//     every screen that can show it, so the wipe is on the other side of the
//     value the screen is built from — the shape `openingVault(_:open:)` uses
//     for the same class of ordering obligation.
//
// ## What a half-completed run leaves
//
// Two outcomes, and both are **states with a name** rather than an accident:
//
//   * **The core call failed.** Nothing local was removed and the session is
//     where it was. The error is thrown to the caller, which renders it and
//     offers the action again. This is the locked-keychain case.
//   * **The core call succeeded and the files did not go.** The five entries
//     are gone, the session is `SignedOut` or `Revoked`, and some vault content
//     survives on disk. That is **not** a failed sign-out and must not be
//     rendered as one: the user *is* signed out, and a `restore()` on the next
//     launch reads an empty store and says so. It is reported as `residue` on
//     an otherwise complete result, and running the sign-out again is a genuine
//     retry because the removal is idempotent.
//
// The residue is stated plainly rather than dressed up: `data.db` holds
// `sync_items.payload` **decrypted** (data-model §A.1), so what survives is
// note content at the container's data-protection class, not ciphertext this
// phone can no longer read. What it is not is reachable — no master key, so no
// vault opens — and it goes when the app is deleted or the retry succeeds.
//
// **There is no Cancel over any of this.** An async core call cannot be
// cancelled (spec-defect 108: `rust_future_cancel` is zero hits), and a
// half-cancelled destruction is the worst outcome available, so the caller
// offers no way to stop one in flight.

/// Why the local content went. Carried out of the service because the two
/// answers are two different screens: one is a sign-in page, the other has to
/// explain itself without accusing the user of anything.
enum LocalWipeReason: Sendable, Equatable {
    /// FR-025. The user asked.
    case signedOutByUser
    /// FR-026. The server said this device is revoked, and the shell found out
    /// on the next call it made.
    case deviceRevoked
}

/// What one completed destruction did.
struct LocalWipe: Sendable, Equatable {
    let reason: LocalWipeReason
    /// The state the core reported **after** its half. Not computed here
    /// (FR-037): the shell renders states, it does not decide them.
    let state: AuthState
    /// `nil` when nothing is left. Non-`nil` when the keys went and some vault
    /// content did not — see the file comment. The user is signed out either
    /// way, so this is never rendered as a failed sign-out.
    let residue: UserFacingError?

    var isComplete: Bool { residue == nil }
}

/// Sign-out and revocation, in the one order that is safe.
struct SignOutService: Sendable {
    private let session: any AuthSessionProtocol
    private let content: any VaultContentRemoval
    private let executor: CoreExecutor

    init(
        session: any AuthSessionProtocol,
        content: any VaultContentRemoval,
        executor: CoreExecutor = .shared
    ) {
        self.session = session
        self.content = content
        self.executor = executor
    }

    /// FR-025. The user signed out.
    ///
    /// `AuthSession.signOut()` is **async and awaited directly** rather than
    /// put on the executor (spec-defect 90): it suspends over a best-effort
    /// `POST /auth/logout` rather than blocking a thread, and parking a queue
    /// thread on a round trip would stall every other core call behind it.
    ///
    /// - Throws: whatever the core raised, with nothing removed locally. A
    ///   `SecureStore.Locked` here is the retryable one.
    func signOut() async throws -> LocalWipe {
        let state = try await session.signOut()
        Log.auth.notice("signed out; removing local vault content")
        return wipe(.signedOutByUser, leaving: state)
    }

    /// FR-026. The server refused this device, and the refusal arrived on a
    /// call the app was making anyway.
    ///
    /// `markRevoked()` is **blocking** and goes on `CoreExecutor` (spec-defect
    /// 90 again, the other half): it makes no request at all — it clears the
    /// store and applies §C.1's edge — so there is nothing to await and a
    /// thread to move off.
    ///
    /// The returned `LocalWipe` is the only thing that produces the revoked
    /// screen, which is the ordering obligation made structural: the wipe has
    /// run by the time the caller holds a value it could render.
    func markRevoked() async throws -> LocalWipe {
        let session = session
        let state = try await executor.run { try session.markRevoked() }
        Log.auth.notice("this device was revoked; removing local vault content")
        return wipe(.deviceRevoked, leaving: state)
    }

    /// The filesystem half, which runs only after the core's half returned.
    ///
    /// It does not throw. By the time it runs the keys are gone and the state
    /// has moved, so a failure here is a fact about the phone's disk and not a
    /// reason to tell the user their sign-out did not happen.
    private func wipe(_ reason: LocalWipeReason, leaving state: AuthState) -> LocalWipe {
        do {
            try content.removeAllVaultContent()
            return LocalWipe(reason: reason, state: state, residue: nil)
        } catch {
            // The mapped code goes to the log, which is where a `StorageError`
            // variant is a diagnostic; the *sentence* is the screen's, because
            // "close Memry and open it again" describes a database this app is
            // still trying to use and there is no longer one. See
            // `AccountCopy.contentSurvived`.
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.fault("local vault content survived", .code(mapped.code))
            return LocalWipe(reason: reason, state: state, residue: AccountCopy.contentSurvived)
        }
    }
}

/// Which core errors mean "this device has been revoked".
///
/// Its own type because the classification is the dangerous part, not the
/// deletion: a matcher that is too wide destroys a working install on a
/// transient 503, and one that is too narrow leaves a revoked phone showing
/// vault content it was told had gone. `ApiError.DeviceRevoked` is what the
/// core raises for the server's `AUTH_DEVICE_REVOKED`
/// (`protocol/http.rs`), and `AuthError` carries it nested.
enum RevocationSignal {
    /// `true` only for the two shapes the core can deliver this in. Every other
    /// error — every transport failure, every other status — is `false`,
    /// including the ones whose copy mentions being signed out.
    static func isRevocation(_ error: any Error) -> Bool {
        if let error = error as? ApiError { return isRevocation(error) }
        if let error = error as? AuthError, case let .Api(source) = error {
            return isRevocation(source)
        }
        return false
    }

    private static func isRevocation(_ error: ApiError) -> Bool {
        if case .DeviceRevoked = error { return true }
        return false
    }
}
