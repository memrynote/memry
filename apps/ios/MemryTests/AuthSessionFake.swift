import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T147's stand-in for the core, T163's traps, T165's provider script.
//
// Its own file since T165: two suites drive it now — `SignInTests` and
// `GoogleButtonTests` — and `SignInTests.swift` had reached its 400-line
// ceiling. Nothing here changed in the move.

// MARK: - A stand-in for the core

/// One scripted answer, consumed in call order.
///
/// It carries **two** states because the real core does: `request_email_code`
/// applies `SignInFailed` before returning its error, so the state after a
/// failed call is not the state the call started from. A fake that left the
/// state alone would let a view model that guesses the state pass.
struct AuthReply: @unchecked Sendable {
    /// What `state()` reports afterwards.
    let resulting: AuthState
    /// What the method itself returns. Normally the same value; a single test
    /// sets them apart, which a real core would never do, to prove which of the
    /// two the view model trusts.
    let returned: AuthState
    let error: (any Error)?
    /// T165. What `complete_provider_sign_in` answered, when the scripted call
    /// is that one. `nil` on every other reply, and reaching it from
    /// `completeProviderSignIn` is a loud failure rather than a zero-flag
    /// default: `needsSetup` false sends the user to unlock and true sends them
    /// to setup, so a fake that invented one would decide the next screen.
    var outcome: ProviderSignInOutcome?

    static func ok(_ state: AuthState, returning returned: AuthState? = nil) -> AuthReply {
        AuthReply(resulting: state, returned: returned ?? state, error: nil, outcome: nil)
    }

    /// A scripted `complete_provider_sign_in`.
    static func provider(
        _ state: AuthState,
        isNewUser: Bool = false,
        needsSetup: Bool = false
    ) -> AuthReply {
        AuthReply(
            resulting: state, returned: state, error: nil,
            outcome: ProviderSignInOutcome(state: state, isNewUser: isNewUser, needsSetup: needsSetup)
        )
    }

    static func fails(_ error: any Error, leaving state: AuthState) -> AuthReply {
        AuthReply(resulting: state, returned: state, error: error, outcome: nil)
    }
}

struct UnscriptedCall: Error {}
/// Deliberately not a `MemryCore` enum: `ErrorMapping` must not recognise it.
struct MysteryFailure: Error {}

final class FakeAuthSession: AuthSessionProtocol, @unchecked Sendable {
    enum Call: Equatable, Sendable {
        case state
        case requestEmailCode(String)
        case resendEmailCode
        case verifyEmailCode(String)
        case registerDevice
        case renewSetupToken
        case signOut
        case markRevoked
        case beginProviderSignIn(AuthProvider)
        case completeProviderSignIn(String)
        case keyMaterial
        case vaults
        // T165.
        case restore
        case abandonProviderSignIn
    }

    private struct Tape {
        var current: AuthState
        var replies: [AuthReply]
        var calls: [Call] = []
        var lastOutcome: ProviderSignInOutcome?
    }

    private let tape: Mutex<Tape>

    init(from state: AuthState, replies: [AuthReply] = []) {
        tape = Mutex(Tape(current: state, replies: replies))
    }

    var calls: [Call] { tape.withLock { $0.calls } }
    private var lastOutcome: ProviderSignInOutcome? { tape.withLock { $0.lastOutcome } }

    /// Running out of script is a loud failure, never a repeat of the last
    /// answer: a test that made more core calls than it wrote down has found
    /// something, and it must not look like a pass.
    private func next(_ call: Call) throws -> AuthState {
        try tape.withLock { tape in
            tape.calls.append(call)
            guard !tape.replies.isEmpty else { throw UnscriptedCall() }
            let reply = tape.replies.removeFirst()
            tape.lastOutcome = reply.outcome
            tape.current = reply.resulting
            if let error = reply.error { throw error }
            return reply.returned
        }
    }

    func state() -> AuthState {
        tape.withLock { tape in
            tape.calls.append(.state)
            return tape.current
        }
    }

    func markRevoked() throws -> AuthState { try next(.markRevoked) }
    func refresh() async throws -> AuthState { try next(.state) }
    func registerDevice() async throws -> AuthState { try next(.registerDevice) }
    func renewSetupToken() async throws -> AuthState { try next(.renewSetupToken) }
    func requestEmailCode(email: String) async throws -> AuthState { try next(.requestEmailCode(email)) }
    func resendEmailCode() async throws { _ = try next(.resendEmailCode) }
    func signOut() async throws -> AuthState { try next(.signOut) }
    func verifyEmailCode(code: String) async throws -> AuthState { try next(.verifyEmailCode(code)) }

    // T165. The two provider edges are scripted now, because T148's button is
    // wired and its tests drive them. `begin` answers with an `AuthState`, so
    // the tape carries it unchanged; `complete` answers with a
    // `ProviderSignInOutcome`, so the tape gained one field rather than a
    // default this side invented.
    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState {
        try next(.beginProviderSignIn(provider))
    }

    func abandonProviderSignIn() throws -> AuthState {
        try next(.abandonProviderSignIn)
    }

    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome {
        let state = try next(.completeProviderSignIn(idToken))
        guard let outcome = lastOutcome else { throw UnscriptedCall() }
        return ProviderSignInOutcome(
            state: state,
            isNewUser: outcome.isNewUser,
            needsSetup: outcome.needsSetup
        )
    }

    // T163's reads and T165's restore. They record the call and then **always**
    // fail. No benign default — an empty vault list, a session that restores to
    // whatever the tape happened to hold — because a fake that answers a call no
    // test wrote down is exactly the shape that let five bugs through this
    // phase. Reaching one of these lines is a finding.
    func keyMaterial() async throws -> KeyMaterial { try trap(.keyMaterial) }

    /// First-device setup's two calls, trapped for the same reason: a fake that
    /// answered "this account has no keys" would send a test into a phrase
    /// nobody scripted.
    func keyMaterialIfConfigured() async throws -> KeyMaterial? { try trap(.keyMaterial) }

    func completeAccountSetup(kdfSaltBase64: String, keyVerifier: String) async throws {
        let _: KeyMaterial = try trap(.keyMaterial)
    }

    func vaults() async throws -> [VaultSummary] { try trap(.vaults) }

    func restore() throws -> AuthState { try trap(.restore) }

    private func trap<T>(_ call: Call) throws -> T {
        tape.withLock { $0.calls.append(call) }
        throw UnscriptedCall()
    }
}
