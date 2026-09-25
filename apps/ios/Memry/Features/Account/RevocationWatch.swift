import Foundation
import MemryCore
import Synchronization

// T159, FR-026: "a revocation detected on next contact". **This is the "next
// contact".**
//
// A device is revoked on a server the phone is not talking to. The only way the
// phone finds out is that some call it was making anyway comes back
// `AUTH_DEVICE_REVOKED`, which the core turns into `ApiError::DeviceRevoked`
// (`protocol/http.rs`) on **any** request. So the detection cannot live in one
// screen: it has to sit where every authenticated call passes, or the phone
// that learns it has been revoked is whichever one happened to open the screen
// somebody remembered to wire.
//
// Before this type, that error reached `VaultSelectionViewModel` as an
// unreadable vault registry and rendered `api.deviceRevoked`'s sentence —
// "**its copy of your vault has been removed**" — with nothing having been
// removed at all. The sentence was false on the only screen that could show it,
// which is exactly what `DESIGN.md` §"Error copy, in detail" and spec-defect
// 111 forbid. This makes it true before it is read.
//
// **A decorator rather than a call-site rule.** Phase 3 shipped five tiers that
// were implemented, tested and never called, and `openingVault(_:open:)` is the
// answer this codebase already chose for that class of problem: put the
// obligation on the other side of the thing the caller wants, so it cannot be
// forgotten. Wrapping the session means every present and future consumer —
// the vault registry, the account key read, the sign-in screen — is watched by
// construction, and a new one added next phase is watched without being told.
//
// **The error is rethrown unchanged.** This type decides nothing about what the
// user sees; it only guarantees the wipe happened first. `ErrorMapping` is
// still the only place the sentence is made (Constitution II).

/// An `AuthSession` that wipes this device the first time the core reports it
/// revoked, before the error reaches the caller.
final class RevocationWatch: AuthSessionProtocol, @unchecked Sendable {
    /// The session underneath. Held as the protocol so the whole type is
    /// testable against a scripted core.
    private let session: any AuthSessionProtocol
    private let onRevoked: @Sendable () async -> Bool
    /// One wipe, not one per concurrent caller. Fifteen calls can fail on the
    /// same revocation — chapter 02 §2.10 records exactly that shape for a dead
    /// token — and running the destruction fifteen times would be fifteen
    /// racing deletions of the same directory, most of which then report a
    /// failure that means "somebody else already did this".
    private let handled = Mutex<Bool>(false)

    /// - Parameter onRevoked: runs the revocation half of `SignOutService` and
    ///   publishes the result. It is **awaited**, so the content is gone before
    ///   the error is rethrown and before any screen built from that error can
    ///   render (data-model §C.1). It answers `false` when the destruction did
    ///   not run — a locked keychain is the case — and the latch is then
    ///   released so the next refusal tries again. Latching on a failure would
    ///   leave a revoked phone holding its vault until it is relaunched.
    init(session: any AuthSessionProtocol, onRevoked: @escaping @Sendable () async -> Bool) {
        self.session = session
        self.onRevoked = onRevoked
    }

    /// Every call the core can answer over the network goes through here.
    private func watching<T>(_ call: () async throws -> T) async throws -> T {
        do {
            return try await call()
        } catch {
            guard RevocationSignal.isRevocation(error) else {
                // The overwhelmingly common path, and the one that must stay
                // boring: a 503, a dropped connection, a rejected code. Nothing
                // is deleted for any of them.
                throw error
            }
            if claim() {
                Log.auth.error("the server reports this device as revoked", .code("api.deviceRevoked"))
                if await onRevoked() == false { release() }
            }
            // Unchanged, and still an error: the caller's own failure path is
            // what it was, and this type is not a place a state is decided.
            throw error
        }
    }

    /// `true` for the first caller only.
    private func claim() -> Bool {
        handled.withLock { alreadyHandled in
            guard !alreadyHandled else { return false }
            alreadyHandled = true
            return true
        }
    }

    /// The destruction did not run, so this is not handled.
    private func release() {
        handled.withLock { $0 = false }
    }

    // MARK: - Watched
    //
    // Every method that reaches the server. `resendEmailCode` and the sign-in
    // edges are here too: they are unauthenticated, so a revocation is not the
    // answer they can get, but forwarding them through the same wrapper costs
    // one line each and means a method added to the protocol is watched unless
    // somebody deliberately puts it in the section below.

    func keyMaterial() async throws -> KeyMaterial {
        try await watching { try await session.keyMaterial() }
    }

    /// Watched like its sibling. A revoked device asking whether the account
    /// has keys gets the revocation, not `nil`: "this account has no key
    /// material" would send it into first-device setup.
    func keyMaterialIfConfigured() async throws -> KeyMaterial? {
        try await watching { try await session.keyMaterialIfConfigured() }
    }

    /// Watched, and the one write in this section. A device whose access was
    /// turned off mid-setup must hear that rather than publish an account's
    /// key material.
    func completeAccountSetup(kdfSaltBase64: String, keyVerifier: String) async throws {
        try await watching {
            try await session.completeAccountSetup(
                kdfSaltBase64: kdfSaltBase64,
                keyVerifier: keyVerifier
            )
        }
    }

    func vaults() async throws -> [VaultSummary] {
        try await watching { try await session.vaults() }
    }

    // Spec 006: the Settings account calls. A revoked device learns it here
    // too, so every one is watched.

    func devices() async throws -> [AccountDevice] {
        try await watching { try await session.devices() }
    }

    func renameDevice(id: String, name: String) async throws {
        try await watching { try await session.renameDevice(id: id, name: name) }
    }

    func revokeDevice(id: String) async throws {
        try await watching { try await session.revokeDevice(id: id) }
    }

    func storage() async throws -> StorageUsage {
        try await watching { try await session.storage() }
    }

    func billing() async throws -> BillingStatus {
        try await watching { try await session.billing() }
    }

    func deleteVault(vaultId: String) async throws {
        try await watching { try await session.deleteVault(vaultId: vaultId) }
    }

    func refresh() async throws -> AuthState {
        try await watching { try await session.refresh() }
    }

    func registerDevice() async throws -> AuthState {
        try await watching { try await session.registerDevice() }
    }

    func renewSetupToken() async throws -> AuthState {
        try await watching { try await session.renewSetupToken() }
    }

    func requestEmailCode(email: String) async throws -> AuthState {
        try await watching { try await session.requestEmailCode(email: email) }
    }

    func resendEmailCode() async throws {
        try await watching { try await session.resendEmailCode() }
    }

    func verifyEmailCode(code: String) async throws -> AuthState {
        try await watching { try await session.verifyEmailCode(code: code) }
    }

    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome {
        try await watching { try await session.completeProviderSignIn(idToken: idToken) }
    }

    /// Not watched for a revocation *by this call*, but still forwarded:
    /// signing out of a revoked device is §C.1's `Revoked -> SignedOut` edge and
    /// is what the revoked screen's own action spends.
    func signOut() async throws -> AuthState {
        try await session.signOut()
    }

    // MARK: - Not watched, because they make no request
    //
    // These are synchronous, and a synchronous method cannot await the wipe —
    // so wrapping them would mean either rethrowing before the content is gone
    // or blocking a thread on a destruction. Neither is needed: none of them
    // talks to a server. `restore()` reads the keychain (chapter 02 §2.14
    // requires it make no request), `markRevoked()` clears the store and
    // applies an edge, `state()` reads a field, and the two provider edges are
    // local bookkeeping over a sheet the shell owns. `ApiError.DeviceRevoked`
    // is a server answer, so none of them can raise one.

    func state() -> AuthState { session.state() }

    /// Builds the approver over the same session; its own calls are single
    /// linking round trips the Link sheet reports itself.
    func deviceApprover() -> DeviceApprover { session.deviceApprover() }

    func restore() throws -> AuthState { try session.restore() }

    func markRevoked() throws -> AuthState { try session.markRevoked() }

    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState {
        try session.beginProviderSignIn(provider: provider)
    }

    func abandonProviderSignIn() throws -> AuthState {
        try session.abandonProviderSignIn()
    }
}
