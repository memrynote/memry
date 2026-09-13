import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T165. The Google button's three core calls, in order, and what happens to the
// machine on every way out of the consent sheet.
//
// **Every assertion names two things**, because the phase's sharpest miss was a
// deleted state guard that left 30 passed / 0 failed: the fall-through branch
// returned an error carrying the same action and the same state as the branch
// it replaced, so two different bugs were indistinguishable. So each case below
// asserts **which** core calls were made *and* which sentence, or which absence
// of one, the user was left with — and the three exits (success, cancellation,
// refusal) are asserted to differ from each other, not merely to be non-nil.

@MainActor
private func googleModel(
    _ replies: [AuthReply],
    flow: @escaping GoogleSignInFlow
) -> (SignInViewModel, FakeAuthSession) {
    let session = FakeAuthSession(from: .signedOut, replies: replies)
    let model = SignInViewModel(
        session: session,
        executor: CoreExecutor(label: "t165.tests"),
        state: .signedOut,
        google: flow
    )
    return (model, session)
}

@Suite("T165 google button")
@MainActor
struct GoogleButtonTests {
    /// The whole path: open the edge, spend the token, register the device.
    ///
    /// The call **list** is asserted, not just the final state: a view model
    /// that skipped `begin_provider_sign_in` and posted the token anyway would
    /// reach the same `registered` and be spending a nonce that no setup token
    /// was signed over (chapter 02 §2.6).
    @Test("a completed consent spends the id token and registers the device")
    func aCompletedConsentRegistersTheDevice() async {
        let (model, session) = googleModel(
            [
                .ok(.awaitingProviderToken(provider: "google")),
                .provider(.setupPending),
                .ok(.registered)
            ],
            flow: { .idToken("header.payload.signature") }
        )

        await model.run(.signInWithGoogle)

        #expect(session.calls == [
            .beginProviderSignIn(.google),
            .completeProviderSignIn("header.payload.signature"),
            .state,
            .registerDevice,
            .state
        ])
        #expect(model.state == .registered)
        #expect(model.error == nil)
    }

    /// Closing the sheet is not an error and it is not a no-op either.
    ///
    /// §C.1 leaves the machine in `AwaitingProviderToken` after
    /// `begin_provider_sign_in`, and the only edge out of it for a cancellation
    /// is `SignInFailed`. Before `abandon_provider_sign_in` existed there was
    /// no exported method that applied it, so this exact sequence stranded the
    /// user in a state whose screen offered no way out.
    @Test("a cancelled consent takes the failure edge and alerts nobody")
    func aCancelledConsentAbandonsTheAttempt() async {
        let (model, session) = googleModel(
            [.ok(.awaitingProviderToken(provider: "google")), .ok(.signedOut)],
            flow: { .cancelled }
        )

        await model.run(.signInWithGoogle)

        #expect(session.calls == [
            .beginProviderSignIn(.google),
            .abandonProviderSignIn,
            .state
        ])
        #expect(model.state == .signedOut)
        // Silent means not alerted. The flow logs it; nothing is shown.
        #expect(model.error == nil)
    }

    /// A Google failure and a cancellation must not look the same. Both end in
    /// `SignedOut` through the same edge; only one of them says anything.
    @Test("a Google failure abandons the attempt and says which failure it was")
    func aGoogleFailureIsNotACancellation() async {
        let (model, session) = googleModel(
            [.ok(.awaitingProviderToken(provider: "google")), .ok(.signedOut)],
            flow: { throw GoogleSignInFailure.tokenExchangeRefused(status: 400) }
        )

        await model.run(.signInWithGoogle)

        #expect(session.calls == [
            .beginProviderSignIn(.google),
            .abandonProviderSignIn,
            .state
        ])
        #expect(model.state == .signedOut)
        #expect(model.error?.code == "googleSignIn.tokenExchangeRefused")
        // And not the unrecognised funnel: a typed Google failure has its own
        // sentence and must never arrive as `shell.unrecognised`.
        #expect(model.error?.code != ErrorMapping.unrecognised.code)
    }

    /// A refusal from **Memry's** server is a third outcome again: the core
    /// applies §C.1's failure edge itself inside `complete_provider_sign_in`,
    /// so nothing abandons anything, and the sentence is the core's rather than
    /// Google's.
    @Test("a refused id token is neither a cancellation nor a Google failure")
    func aRefusedIdTokenIsItsOwnOutcome() async {
        let (model, session) = googleModel(
            [
                .ok(.awaitingProviderToken(provider: "google")),
                .fails(AuthError.NoSetupToken, leaving: .signedOut)
            ],
            flow: { .idToken("header.payload.signature") }
        )

        await model.run(.signInWithGoogle)

        #expect(session.calls == [
            .beginProviderSignIn(.google),
            .completeProviderSignIn("header.payload.signature"),
            .state
        ])
        // Emphatically **not** abandoned: a second failure edge from
        // `SignedOut` would be `InvalidState` and would replace the sentence
        // the user needs with one about the shell.
        #expect(!session.calls.contains(.abandonProviderSignIn))
        #expect(model.state == .signedOut)
        #expect(model.error?.code == "auth.noSetupToken")
    }

    /// The sheet is never opened when the core refuses the edge — a second
    /// Google sign-in racing the first must not produce a second consent
    /// screen.
    @Test("a refused edge opens no consent sheet")
    func aRefusedEdgeOpensNoSheet() async {
        let opened = Mutex<Int>(0)
        let (model, session) = googleModel(
            [.fails(AuthError.InvalidState(action: "open a provider sheet", state: "Registered"),
                    leaving: .registered)],
            flow: {
                opened.withLock { $0 += 1 }
                return .cancelled
            }
        )

        await model.run(.signInWithGoogle)

        #expect(opened.withLock { $0 } == 0)
        #expect(session.calls == [.beginProviderSignIn(.google), .state])
        #expect(model.error?.code == "auth.invalidState")
        // spec-defect 111: true on this screen, which is the app's root and
        // cannot be closed.
        #expect(model.error?.guidance == "Nothing has changed and nothing is lost. Start that step again.")
    }

    /// The stranded state has a way out of its own, for the case where the flow
    /// above did not get to run its `abandon`.
    @Test("the waiting step offers the edge back to signed out")
    func theWaitingStepOffersAWayOut() async {
        let session = FakeAuthSession(
            from: .awaitingProviderToken(provider: "google"),
            replies: [.ok(.signedOut)]
        )
        let model = SignInViewModel(
            session: session,
            executor: CoreExecutor(label: "t165.tests"),
            state: .awaitingProviderToken(provider: "google")
        )

        #expect(model.step.primary == .abandonProviderSignIn)
        await model.run(.abandonProviderSignIn)

        #expect(session.calls == [.abandonProviderSignIn, .state])
        #expect(model.state == .signedOut)
    }
}
