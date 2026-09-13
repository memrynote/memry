import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T147, the half that needs no core. `SignInWiringTests.swift` is the other
// half: the real `Keychain` and the real `URLSessionTransport` behind a real
// `AuthSession`.
//
// **Why the assertions are shaped the way they are.** `error != nil` passes
// under almost every bug a sign-in screen can have — a wrong mapping, a wrong
// state, a collapsed pair of variants, the whole rate-limit budget deleted. So
// each test below names **which** state the machine reports and **which**
// literal sentence a specific error produced. The literals are written out
// rather than compared against `ErrorMapping.userFacing(...)`: comparing two
// mapped values is how a collapse stays green, because both sides move
// together (phase 4's second weak assertion).

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

    static func ok(_ state: AuthState, returning returned: AuthState? = nil) -> AuthReply {
        AuthReply(resulting: state, returned: returned ?? state, error: nil)
    }

    static func fails(_ error: any Error, leaving state: AuthState) -> AuthReply {
        AuthReply(resulting: state, returned: state, error: error)
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
    }

    private struct Tape {
        var current: AuthState
        var replies: [AuthReply]
        var calls: [Call] = []
    }

    private let tape: Mutex<Tape>

    init(from state: AuthState, replies: [AuthReply] = []) {
        tape = Mutex(Tape(current: state, replies: replies))
    }

    var calls: [Call] { tape.withLock { $0.calls } }

    /// Running out of script is a loud failure, never a repeat of the last
    /// answer: a test that made more core calls than it wrote down has found
    /// something, and it must not look like a pass.
    private func next(_ call: Call) throws -> AuthState {
        try tape.withLock { tape in
            tape.calls.append(call)
            guard !tape.replies.isEmpty else { throw UnscriptedCall() }
            let reply = tape.replies.removeFirst()
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

    // T163's four methods. They record the call and then **always** fail.
    //
    // The tape cannot script them: `AuthReply` carries an `AuthState`, and
    // three of these four answer with something else. Rather than invent a
    // benign default — an empty vault list, a zero-flag outcome — each one
    // traps, because a fake that answers a call no test wrote down is exactly
    // the shape that let five bugs through this phase. The first test that
    // needs one of these answers (T148, T152, T155) widens the tape to carry
    // it; until then, reaching one of these lines is a finding.
    func beginProviderSignIn(provider: AuthProvider) throws -> AuthState {
        try trap(.beginProviderSignIn(provider))
    }

    func completeProviderSignIn(idToken: String) async throws -> ProviderSignInOutcome {
        try trap(.completeProviderSignIn(idToken))
    }

    func keyMaterial() async throws -> KeyMaterial { try trap(.keyMaterial) }

    func vaults() async throws -> [VaultSummary] { try trap(.vaults) }

    private func trap<T>(_ call: Call) throws -> T {
        tape.withLock { $0.calls.append(call) }
        throw UnscriptedCall()
    }
}

@MainActor
private func makeModel(from state: AuthState, _ replies: [AuthReply]) -> (SignInViewModel, FakeAuthSession) {
    let session = FakeAuthSession(from: state, replies: replies)
    // A private executor, so a test never shares a backlog with another.
    let model = SignInViewModel(session: session, executor: CoreExecutor(label: "t147.tests"), state: state)
    return (model, session)
}

// MARK: - Which server this build talks to

@Suite("T147 sync environment")
struct SyncEnvironmentTests {
    @Test("a debug build with nothing configured is staging")
    func debugDefaultsToStaging() {
        #expect(
            SyncEnvironmentResolver.resolve(configuredName: nil, launchArguments: [], isDebugBuild: true)
                == .resolved(.staging)
        )
    }

    /// The failure this rule exists for: a Memry worktree missing its env file
    /// has silently resolved to `http://localhost:8787` and looked like it
    /// worked. An unconfigured build says so instead.
    @Test("an unconfigured release build is a fault and never localhost")
    func releaseWithoutConfigurationIsAFault() {
        let choice = SyncEnvironmentResolver.resolve(
            configuredName: nil, launchArguments: [], isDebugBuild: false
        )
        #expect(choice == .misconfigured(.notConfigured))
        #expect(choice != .resolved(.local))
        #expect(choice != .resolved(.production))
    }

    @Test("production is unreachable from a debug build and from a launch argument")
    func productionIsNotReachableByAccident() {
        #expect(
            SyncEnvironmentResolver.resolve(configuredName: "production", launchArguments: [], isDebugBuild: true)
                == .misconfigured(.productionNotSelectable)
        )
        #expect(
            SyncEnvironmentResolver.resolve(
                configuredName: nil,
                launchArguments: ["--sync-environment=production"],
                isDebugBuild: false
            ) == .misconfigured(.productionNotSelectable)
        )
        // The one door it has, so the rule above is a refusal rather than the
        // environment being unreachable at all.
        #expect(
            SyncEnvironmentResolver.resolve(configuredName: "production", launchArguments: [], isDebugBuild: false)
                == .resolved(.production)
        )
    }

    @Test("a name that matches nothing is refused rather than defaulted through")
    func unrecognisedNamesAreRefused() {
        #expect(
            SyncEnvironmentResolver.resolve(configuredName: "stagin", launchArguments: [], isDebugBuild: true)
                == .misconfigured(.unrecognisedName)
        )
        #expect(
            SyncEnvironmentResolver.resolve(
                configuredName: nil, launchArguments: ["--sync-environment=prod"], isDebugBuild: true
            ) == .misconfigured(.unrecognisedName)
        )
    }

    @Test("local is reachable only by an explicit argument")
    func localNeedsAskingFor() {
        #expect(
            SyncEnvironmentResolver.resolve(
                configuredName: nil, launchArguments: ["--sync-environment=local"], isDebugBuild: true
            ) == .resolved(.local)
        )
    }

    @Test("the three base URLs are the three deployments, spelled out")
    func baseURLs() {
        #expect(SyncEnvironment.staging.baseURL == "https://sync-staging.memrynote.com")
        #expect(SyncEnvironment.production.baseURL == "https://sync.memrynote.com")
        #expect(SyncEnvironment.local.baseURL == "http://localhost:8787")
    }

    @Test("every fault says what failed, that nothing was contacted, and offers no retry")
    func faultCopy() {
        for fault in [
            SyncEnvironmentFault.unrecognisedName,
            .productionNotSelectable,
            .notConfigured
        ] {
            let shown = fault.userFacing
            #expect(!shown.title.isEmpty)
            #expect(shown.guidance?.contains("has not contacted anything") == true)
            #expect(shown.recourse == .blocked)
            #expect(shown.isUserVisible)
        }
    }
}

// MARK: - What each reported state shows

@Suite("T147 sign-in steps")
struct SignInStepTests {
    static let everyState: [AuthState] = [
        .signedOut, .awaitingOtp(email: "someone@example.com"),
        .awaitingProviderToken(provider: "google"), .setupPending, .setupExpired,
        .registered, .refreshing, .sessionExpired, .revoked
    ]

    @Test("all nine states render, and no two share a title")
    func nineDistinctSteps() {
        let titles = Set(Self.everyState.map { SignInStep($0).title })
        // The failure this catches is a copy-paste collapse, where two states
        // render the same sentence and the screen silently lies about one.
        #expect(titles.count == 9)
        for state in Self.everyState {
            let step = SignInStep(state)
            #expect(!step.title.isEmpty)
            #expect(!step.detail.isEmpty)
        }
    }

    @Test("the code step names the address the core reported")
    func codeStepNamesTheAddress() {
        let step = SignInStep(.awaitingOtp(email: "kaan@example.com"))
        #expect(step.field == .code)
        #expect(step.detail.contains("kaan@example.com"))
        #expect(step.primary == .verify)
        #expect(step.secondary == .resend)
    }

    @Test("only the states with an edge out of them offer an action")
    func actionsMatchTheEdges() {
        #expect(SignInStep(.signedOut).primary == .sendCode)
        #expect(SignInStep(.setupPending).primary == .registerDevice)
        #expect(SignInStep(.setupExpired).primary == .renewSetup)
        #expect(SignInStep(.sessionExpired).primary == .startOver)
        #expect(SignInStep(.revoked).primary == .startOver)
        // Nothing this screen can do: registration finished, the core is
        // refreshing on its own, or T148's sheet is open.
        #expect(SignInStep(.registered).primary == nil)
        #expect(SignInStep(.refreshing).primary == nil)
        #expect(SignInStep(.awaitingProviderToken(provider: "google")).primary == nil)
    }

    /// Spec-defect 94: there is no iOS support or feedback channel and none is
    /// invented, so no copy on this screen may send a user to one.
    @Test("no copy promises a place to report a problem")
    func noSupportChannelIsInvented() {
        var sentences = Self.everyState.flatMap { [SignInStep($0).title, SignInStep($0).detail] }
        sentences += [SignInErrors.codeNotSixDigits.text, SignInErrors.codeRequestsSpent.text]
        for sentence in sentences {
            for banned in ["report", "support", "contact us", "get in touch"] {
                #expect(sentence.range(of: banned, options: .caseInsensitive) == nil)
            }
        }
    }
}

// MARK: - Driving the machine

@Suite("T147 sign-in view model")
@MainActor
struct SignInViewModelTests {
    /// The core moves the state on the way out of a failure, so the view has to
    /// re-read it. The two states below disagree on purpose — a real core would
    /// never return one thing and report another — which is what makes this
    /// fail if the view model trusts a returned value instead of re-reading.
    @Test("the state shown is the one the core reports, not the one a call returned")
    func stateIsReadBackNotAssumed() async {
        let (model, session) = makeModel(from: .signedOut, [
            .ok(.awaitingOtp(email: "kaan@example.com"), returning: .registered)
        ])
        model.email = "kaan@example.com"
        await model.run(.sendCode)

        #expect(model.state == .awaitingOtp(email: "kaan@example.com"))
        #expect(session.calls.contains(.state))
        #expect(model.step.field == .code)
    }

    @Test("a rate-limited send renders the mapped sentence and never the server's message")
    func rateLimitCopy() async {
        let serverMessage = "Too many OTP requests for this email"
        let (model, _) = makeModel(from: .signedOut, [
            // The core applies `SignInFailed` before returning, which is why
            // the state it leaves behind is `SignedOut`.
            .fails(ApiError.RateLimited(retryAfterS: 30, message: serverMessage), leaving: .signedOut)
        ])
        model.email = "kaan@example.com"
        await model.run(.sendCode)

        #expect(model.state == .signedOut)
        #expect(model.error?.code == ErrorCode("api.rateLimited"))
        #expect(model.error?.title == "Memry is being asked to slow down.")
        // Constitution II: no raw error object, no server string, and no
        // `retryAfterS` rendered as a duration the user cannot use.
        #expect(model.error?.text.contains(serverMessage) == false)
        #expect(model.error?.text.contains("30") == false)
    }

    @Test("a code that is not six digits never reaches the core")
    func shortCodeIsRefusedLocally() async {
        let (model, session) = makeModel(from: .awaitingOtp(email: "kaan@example.com"), [])
        model.code = "12345"
        await model.run(.verify)

        #expect(session.calls.isEmpty)
        #expect(model.error?.code == ErrorCode("signIn.codeNotSixDigits"))
        #expect(model.error?.title == "A Memry code is six digits.")
        // The field keeps what the user typed: an unreadable input must never
        // be silently emptied into something that reads as "nothing wrong".
        #expect(model.code == "12345")
    }

    /// Research R14: paste is the mechanism, autofill is a bonus. An email
    /// client's whole sentence pastes and works.
    @Test("a pasted sentence yields the six digits")
    func pasteIsTheMechanism() async {
        let (model, session) = makeModel(from: .awaitingOtp(email: "kaan@example.com"), [
            .ok(.setupPending), .ok(.registered)
        ])
        model.code = "Your Memry code is 123 456"
        await model.run(.verify)

        #expect(session.calls.contains(.verifyEmailCode("123456")))
        #expect(model.state == .registered)
    }

    /// Chapter 02 §2.11: three per address per ten minutes, and the request
    /// past the cap is the one that sits on the core's retry ladder.
    @Test("the screen stops at three codes for one address")
    func codeBudgetIsThree() async {
        let (model, session) = makeModel(from: .signedOut, [
            .ok(.awaitingOtp(email: "kaan@example.com")),
            .ok(.awaitingOtp(email: "kaan@example.com")),
            .ok(.awaitingOtp(email: "kaan@example.com"))
        ])
        model.email = "kaan@example.com"
        await model.run(.sendCode)
        await model.run(.resend)
        await model.run(.resend)
        await model.run(.resend)

        let sends = session.calls.filter {
            $0 == .resendEmailCode || $0 == .requestEmailCode("kaan@example.com")
        }
        #expect(sends.count == 3)
        #expect(model.codeRequestsUsed == 3)
        #expect(model.error?.code == ErrorCode("signIn.codeRequestsSpent"))
        #expect(model.error?.recourse == .retryLater)
    }

    @Test("a different address starts a new budget")
    func budgetIsPerAddress() async {
        let (model, session) = makeModel(from: .signedOut, [
            .fails(ApiError.Status(status: 400, code: "VALIDATION_ERROR", message: "no"), leaving: .signedOut),
            .fails(ApiError.Status(status: 400, code: "VALIDATION_ERROR", message: "no"), leaving: .signedOut),
            .fails(ApiError.Status(status: 400, code: "VALIDATION_ERROR", message: "no"), leaving: .signedOut),
            .ok(.awaitingOtp(email: "second@example.com"))
        ])
        model.email = "first@example.com"
        for _ in 0..<3 { await model.run(.sendCode) }
        model.email = "second@example.com"
        await model.run(.sendCode)

        #expect(session.calls.contains(.requestEmailCode("second@example.com")))
        #expect(model.codeRequestsUsed == 1)
    }

    @Test("a verified code registers the device without asking again")
    func verifyChainsIntoRegistration() async {
        let (model, session) = makeModel(from: .awaitingOtp(email: "kaan@example.com"), [
            .ok(.setupPending), .ok(.registered)
        ])
        model.code = "123456"
        await model.run(.verify)

        let edges = session.calls.filter { $0 != .state }
        #expect(edges == [.verifyEmailCode("123456"), .registerDevice])
        #expect(model.state == .registered)
        #expect(model.error == nil)
    }

    @Test("a failed registration leaves the step offering it again")
    func registrationCanBeRetried() async {
        let (model, _) = makeModel(from: .awaitingOtp(email: "kaan@example.com"), [
            .ok(.setupPending),
            .fails(AuthError.NoSetupToken, leaving: .setupPending)
        ])
        model.code = "123456"
        await model.run(.verify)

        #expect(model.state == .setupPending)
        #expect(model.step.primary == .registerDevice)
        #expect(model.error?.title == "Memry could not finish setting up this phone.")
    }

    @Test("a rejected code is cleared from the field and the core says where the user is")
    func rejectedCodeIsCleared() async {
        let (model, _) = makeModel(from: .awaitingOtp(email: "kaan@example.com"), [
            .fails(ApiError.Status(status: 400, code: "VALIDATION_ERROR", message: "bad"), leaving: .signedOut)
        ])
        model.code = "123456"
        await model.run(.verify)

        #expect(model.code.isEmpty)
        #expect(model.state == .signedOut)
        #expect(model.step.field == .email)
        // A 4xx the client has no policy for must not read as transient.
        #expect(model.error?.recourse == .blocked)
        #expect(model.error?.title == "The Memry server refused that request.")
    }

    /// `DESIGN.md`: silent means not alerted, never not known.
    @Test("a swallowed failure alerts nobody and still moves the state on")
    func swallowedFailureIsNotShown() async {
        let (model, session) = makeModel(from: .signedOut, [
            .fails(TransportError.Cancelled, leaving: .signedOut)
        ])
        model.email = "kaan@example.com"
        await model.run(.sendCode)

        #expect(model.error == nil)
        #expect(session.calls.contains(.state))
    }

    @Test("an error with no mapping is loud and carries an identifying code")
    func unmappedErrorRendersItsCode() async {
        let (model, _) = makeModel(from: .signedOut, [.fails(MysteryFailure(), leaving: .signedOut)])
        model.email = "kaan@example.com"
        await model.run(.sendCode)

        #expect(model.error?.code == ErrorMapping.unrecognised.code)
        #expect(model.visibleErrorCode == "shell.unrecognised")

        // And only that one: every mapped error keeps its code in the log.
        let (mapped, _) = makeModel(from: .signedOut, [
            .fails(TransportError.Offline, leaving: .signedOut)
        ])
        mapped.email = "kaan@example.com"
        await mapped.run(.sendCode)
        #expect(mapped.error?.title == "You are offline.")
        #expect(mapped.visibleErrorCode == nil)
    }

    @Test("an expired session offers the only edge out of it")
    func expiredSessionStartsOver() async {
        let (model, session) = makeModel(from: .sessionExpired, [.ok(.signedOut)])
        #expect(model.step.primary == .startOver)
        await model.run(.startOver)

        #expect(session.calls.contains(.signOut))
        #expect(model.state == .signedOut)
    }

    @Test("a send with an empty address enters neither the core nor the budget")
    func emptyAddressDoesNothing() async {
        let (model, session) = makeModel(from: .signedOut, [])
        model.email = "   "
        #expect(!model.isEnabled(.sendCode))
        await model.run(.sendCode)

        #expect(session.calls.isEmpty)
        #expect(model.codeRequestsUsed == 0)
        #expect(model.error == nil)
    }
}
