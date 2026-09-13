import Foundation
import MemryCore

// T165. The production ``AccountKeyMaterialSource``, and the end of T152's
// dark route.
//
// `RecoveryPhraseUnlock.swift` shipped this protocol with the note "nothing in
// this build implements this": chapter 02 §2.1.1's `GET /auth/key-verifier`
// had no export, `AuthStartup.keyMaterial` was `nil` in production, and the
// unlock screen was reachable in a test and nowhere else (spec-defect 114).
// T163 exported `AuthSession.keyMaterial()`. This is the twenty lines that
// spend it.
//
// **The shell does not fetch this itself, and could not.** The route is
// `Auth::Session`-authenticated: an access token, a `401`, a refresh and a
// replay, all of which live in the core's `HttpClient`. What crosses here is
// two already-encoded strings.

/// ``AccountKeyMaterialSource`` over the core's own account read.
struct CoreAccountKeyMaterial: AccountKeyMaterialSource {
    private let session: any AuthSessionProtocol

    init(session: any AuthSessionProtocol) {
        self.session = session
    }

    /// - Throws: whatever the core raised, unchanged, so `ErrorMapping` sees
    ///   the real `ApiError` rather than a shell-invented stand-in. A `401`
    ///   that the refresh could not rescue must reach the user as an expired
    ///   session and not as a phrase that did not match.
    func accountKeyMaterial() async throws -> AccountKeyMaterial {
        // Awaited directly, never through `CoreExecutor`: `keyMaterial()`
        // suspends rather than blocks (spec-defect 90), and pushing it through
        // the serial queue would park a queue thread on a semaphore behind a
        // network round trip and stall every other core call behind it.
        let material = try await session.keyMaterial()

        // Chapter 01 §1.1: the salt crosses as base64 and Argon2id needs the
        // bytes. Its **length** is not checked here — `derive_master_key` owns
        // that rule and a second copy of it in the shell is a second thing to
        // keep in step (FR-037).
        guard let kdfSalt = Data(base64Encoded: material.kdfSalt) else {
            // The answer arrived and could not be read, which is a different
            // fact from a refusal and must not read as one.
            throw ApiError.MalformedResponse(
                path: "/auth/key-verifier",
                what: "the kdf salt is not base64"
            )
        }
        // The verifier is **not** decoded. Chapter 01 §1.4.1 compares the
        // base64 strings, and `accountKeyVerifierMatches` is what does it.
        return AccountKeyMaterial(kdfSalt: kdfSalt, keyVerifier: material.keyVerifier)
    }
}
