import Foundation
import MemryCore
import Observation

// T147. The screen's whole relationship with the core.
//
// **The core owns the state machine, and this holds a snapshot of it.**
// `@MainActor @Observable` over value snapshots is research R15's shape: every
// state rendered is one an `AuthSession` returned or one `state()` reported,
// never one computed here. After a failure the state is **re-read** rather than
// assumed, because the core applies `SignInFailed` on the way out and the state
// the action started from is no longer the state the user is in.
//
// **Nothing here retries, refreshes, or decides a session is over.** Chapter 02
// §2.10's ladder, the single-flight refresh and the rejection latch are all
// inside the core. The one thing this file counts is how many codes it has
// asked for, and that is a **budget on its own behaviour**, not a retry: §2.11
// caps an address at three codes per ten minutes, and the request past the cap
// is the one the core's `retryOn429` ladder then sits on for as long as the
// server's `Retry-After` header says — which on the per-IP limiter is the
// remainder of a **3600 second** window, applied up to three times.
//
// That wait cannot be shortened from here and it cannot be interrupted: the
// generated `uniffiRustCallAsync` bridges the Rust future with
// `withUnsafeContinuation` and never calls `rust_future_cancel`, which appears
// **zero** times in the generated Swift, so cancelling the Swift `Task` does
// not stop an in-flight `AuthSession` call. Not walking into the wait is the
// only lever the shell has, so this screen stops at three.

@MainActor
@Observable
final class SignInViewModel {
    /// Chapter 02 §2.11 `MAX_EMAIL_REQUESTS`, per address per 600 s.
    static let maxCodeRequests = 3
    /// Chapter 02 §2.11 `OTP_LENGTH`.
    static let codeLength = 6

    /// The last state the core reported. Never assigned from anything else.
    private(set) var state: AuthState
    /// The action the core is working on right now, or `nil`. One value rather
    /// than a `Bool`, so the spinner can say **which** wait the user is in.
    private(set) var runningAction: SignInAction?
    var isWorking: Bool { runningAction != nil }
    /// The last **user-visible** mapped failure. A swallowed one is logged and
    /// leaves this `nil`, which is "not alerted", never "not known".
    private(set) var error: UserFacingError?

    var email = ""
    /// Held raw. Normalised only at submit time, so a paste that could not be
    /// read never silently empties the field the user is looking at.
    var code = ""

    private(set) var codeRequestsUsed = 0
    private var requestedAddress: String?

    private let session: any AuthSessionProtocol
    private let executor: CoreExecutor

    /// - Parameter state: read from the core before this object exists, so
    ///   there is no instant at which the view shows a state nobody reported.
    init(session: any AuthSessionProtocol, executor: CoreExecutor, state: AuthState) {
        self.session = session
        self.executor = executor
        self.state = state
    }

    // MARK: - What the screen shows

    var step: SignInStep { SignInStep(state) }

    /// `DESIGN.md`: "An error with no mapping still renders a title and an
    /// identifying code." Only that one. A stable code under every message is
    /// clutter, and the codes exist for the log.
    var visibleErrorCode: String? {
        guard let error, error.code == ErrorMapping.unrecognised.code else { return nil }
        return error.code.description
    }

    /// A button the user cannot press and cannot explain is worse than one that
    /// answers when pressed, so the code budget is **not** a disabled control:
    /// pressing past it renders `codeRequestsSpent`.
    func isEnabled(_ action: SignInAction) -> Bool {
        guard !isWorking else { return false }
        switch action {
        case .sendCode: return !trimmedEmail.isEmpty
        case .verify: return !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .resend, .registerDevice, .renewSetup, .startOver: return true
        }
    }

    // MARK: - Edges

    func run(_ action: SignInAction) async {
        switch action {
        case .sendCode: await sendCode()
        case .verify: await verify()
        case .resend: await resend()
        case .registerDevice: await registerDevice()
        case .renewSetup: await renewSetup()
        case .startOver: await startOver()
        }
    }

    private var trimmedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func sendCode() async {
        let address = trimmedEmail
        guard !address.isEmpty else { return }
        // The cap is per address: typing a different one is a different budget,
        // which is what the server counts too.
        if address != requestedAddress {
            requestedAddress = address
            codeRequestsUsed = 0
        }
        guard spendCodeRequest() else { return }
        await perform(.sendCode) { _ = try await $0.requestEmailCode(email: address) }
    }

    /// Chapter 02 §2.11: a resend is not a state transition, so nothing here
    /// expects one. It does spend a code.
    private func resend() async {
        guard spendCodeRequest() else { return }
        await perform(.resend) { try await $0.resendEmailCode() }
    }

    /// `true` when there was budget left. Counts the **attempt**, not the
    /// success: a request the server refused still left this screen, and
    /// counting only successes is how a screen walks into the cap.
    private func spendCodeRequest() -> Bool {
        guard codeRequestsUsed < Self.maxCodeRequests else {
            record(SignInErrors.codeRequestsSpent)
            return false
        }
        codeRequestsUsed += 1
        return true
    }

    private func verify() async {
        // Paste is the mechanism, not autofill (research R14), so an email
        // client's "your code is 123456" pastes and works. Anything that is not
        // exactly six digits is refused out loud rather than trimmed into
        // something plausible.
        let digits = code.filter(\.isNumber)
        guard digits.count == Self.codeLength else {
            record(SignInErrors.codeNotSixDigits)
            return
        }
        guard await perform(.verify, { _ = try await $0.verifyEmailCode(code: digits) }) else {
            // The core has already moved to `SignedOut`; a rejected code must
            // not sit in the field waiting to be resubmitted.
            code = ""
            return
        }
        code = ""
        await registerIfPending()
    }

    /// `SetupPending -> Registered` follows the verify without asking, because
    /// the user has nothing left to decide and the grant is five minutes long
    /// (chapter 02 §2.11 `SETUP_TOKEN_EXPIRY`). If it fails, the step's own
    /// button offers it again rather than stranding the session.
    private func registerIfPending() async {
        guard state == .setupPending else { return }
        await registerDevice()
    }

    private func registerDevice() async {
        await perform(.registerDevice) { _ = try await $0.registerDevice() }
    }

    private func renewSetup() async {
        guard await perform(.renewSetup, { _ = try await $0.renewSetupToken() }) else { return }
        await registerIfPending()
    }

    /// §C.1's `SessionExpired -> SignedOut` and `Revoked -> SignedOut`.
    ///
    /// `sign_out` clears the five keychain entries and nothing else, which is
    /// all there is to clear at this point in the phase; the databases and
    /// `images/` are **T159's**, and so is recording why a revocation happened.
    private func startOver() async {
        await perform(.startOver) { _ = try await $0.signOut() }
        code = ""
    }

    // MARK: - The one path into the core

    @discardableResult
    private func perform(
        _ action: SignInAction,
        _ work: (any AuthSessionProtocol) async throws -> Void
    ) async -> Bool {
        guard !isWorking else { return false }
        runningAction = action
        error = nil
        var succeeded = true
        do {
            // Awaited directly, never through `CoreExecutor`: these seven
            // methods suspend rather than block (spec-defect 90), and pushing
            // one through the serial queue parks a queue thread on a semaphore
            // behind a network round trip.
            try await work(session)
        } catch {
            succeeded = false
            record(ErrorMapping.userFacing(error))
        }
        await readState()
        runningAction = nil
        return succeeded
    }

    /// `state()` is one of the two **synchronous** `AuthSession` methods, so it
    /// blocks the calling thread and goes through the executor.
    private func readState() async {
        do {
            state = try await executor.run { [session] in session.state() }
        } catch {
            // `run` throws only on cancellation, which means this view is going
            // away. The last reported state stands rather than being replaced
            // by a guess.
            Log.auth.debug("auth state read did not complete")
        }
    }

    /// Logged whatever its visibility (`DESIGN.md`: silent means not alerted,
    /// never not known). The code is a literal minted in the shell and carries
    /// no part of the error's payload.
    private func record(_ mapped: UserFacingError) {
        Log.auth.error("sign-in step failed", .code(mapped.code))
        error = mapped.isUserVisible ? mapped : nil
    }
}
