import Foundation
import MemryCore
import Observation

// T153 and T154. Unlocking this phone by scanning the code a signed-in
// computer is showing (FR-020, chapter 03), and **the production call site
// `DeviceLink` did not have** (spec-defect 114).
//
// One flow and one view model: the scan and the comparison are two screens of
// the same 300-second session, and splitting the state across two objects is
// how "which session is this SAS for" becomes a question.
//
// **Linking replaces the recovery phrase, not the sign-in.** The phone has
// already signed in and already registered its device by the time this screen
// exists — `AuthState.registered` is what routes to it — so nothing here
// registers anything. What linking supplies is the master key, which the
// phrase path otherwise derives from 24 words.
//
// **The shell drives the camera, not the core** (spec-defect 107). Nothing in
// the generated Swift accepts a `CodeCapture`, so this file calls `scan()`
// itself and hands the decoded string to `DeviceLink.scan(qrPayload:)`
// unread — the seam's rule, kept: the core is the only parser of a
// security-relevant format.
//
// **The poll timer is the shell's, and that is normative** (§3.9, amended for
// spec-defect 126). `pollOnce()` issues exactly one request and never sleeps.
// The cadence below is desktop's 3 s — 20 requests per 60 s against §3.4's
// budget of 30 — and `PollBudgetExhausted` is honoured by waiting the
// `retryInMs` the core computed, never by polling harder.
//
// **Nothing here can cancel a call in flight** (spec-defect 108). `scan` and
// `pollOnce` are async and uncancellable, so no screen offers a Cancel over
// one. What a user gets instead is `stop()`: it stops the *timer* and calls
// the blocking `cancel()`, which zeroes the three subkeys.
//
// **No payload, secret, session id or SAS code reaches a log.** `Log`'s
// surface is a `StaticString` plus a closed `LogDetail`, so there is nowhere
// to put one.

@MainActor
@Observable
final class DeviceLinkingViewModel {
    /// Where the flow is. Eight cases, and the four that a §3.12 failure can
    /// end in are deliberately not one: an expired window, a refused link, a
    /// code that was never a Memry code and a phone that is already linked are
    /// four different facts about four different next actions.
    enum Phase: Equatable {
        /// Nothing started. Scan, or paste the code.
        case idle
        /// The camera is running. Abandonable — this is the shell's own call.
        case scanning
        /// `DeviceLink.scan` is in flight. **Not** abandonable, and no screen
        /// pretends otherwise.
        case submitting
        /// The SAS is on screen and the timer is polling.
        case confirming
        /// §3.4's window closed. Its own state, not a failure of the user's
        /// eyesight, and not something a retry of the same code can fix.
        case expired
        /// The link ended and cannot continue. ``error`` says why.
        case failed
        /// The master key is in the secure store.
        case linked
        /// This phone already holds the account's master key, so there is
        /// nothing to link and a second link would mint a duplicate
        /// registration against the account's 50-device budget.
        case alreadyLinked
    }

    /// §3.4's budget is 30 requests per 60 seconds per session. Desktop polls
    /// every 3 s, which is 20 per 60 s; matching it stays comfortably inside a
    /// cap a client that cannot count its own requests could not honour.
    static let pollInterval = Duration.seconds(3)

    private(set) var phase: Phase = .idle
    /// §3.6's six decimal digits, shown on both screens. Not key material: a
    /// 19.93-bit fingerprint of a shared secret that is itself discarded.
    private(set) var sasCode: String?
    /// The server's `expiresAt`, epoch seconds (§3.4). Rendered from this
    /// rather than from 300, because the server chooses it.
    private(set) var expiresAt: Int64?
    /// §3.10's transferred list, empty when the computer sent no block.
    private(set) var vaults: [VaultSummary] = []
    private(set) var error: UserFacingError?
    /// Set only once the master key is in the secure store.
    private(set) var isLinked = false
    /// What the user pastes when the camera cannot be used. First-class: the
    /// simulator and CI have no camera at all (research R13).
    var typedPayload = ""

    private let link: any DeviceLinkProtocol
    private let capture: any CodeCapture
    private let secureStore: any SecureStore
    private let executor: CoreExecutor
    private let now: @Sendable () -> Date
    private var pollTask: Task<Void, Never>?

    init(
        link: any DeviceLinkProtocol,
        capture: any CodeCapture,
        secureStore: any SecureStore,
        executor: CoreExecutor,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.link = link
        self.capture = capture
        self.secureStore = secureStore
        self.executor = executor
        self.now = now
    }

    // MARK: - What the screens show

    var isWorking: Bool { phase == .scanning || phase == .submitting }

    var canSubmitTypedPayload: Bool { !isWorking && !typedPayload.isEmpty }

    /// `DESIGN.md`: an error with no mapping renders an identifying code.
    var visibleErrorCode: String? {
        guard let error, error.code == ErrorMapping.unrecognised.code else { return nil }
        return error.code.description
    }

    /// The window, in whole minutes, honestly and coarsely.
    ///
    /// `DESIGN.md` refuses "43 seconds remain", and a code that visibly ticks
    /// is manufactured urgency over a comparison the user should take their
    /// time with. `nil` once the window is gone, which the screen renders as
    /// ``Phase/expired`` rather than as "0 minutes".
    var minutesRemaining: Int? {
        guard let expiresAt else { return nil }
        let seconds = expiresAt - Int64(now().timeIntervalSince1970)
        guard seconds > 0 else { return nil }
        return max(1, Int((seconds + 59) / 60))
    }

    // MARK: - Starting

    /// The T154 edge case, checked **before** anything is scanned.
    ///
    /// Chapter 01 §1.6 stores one master key per account, so a phone that
    /// holds one is already linked for every vault. Re-running the flow would
    /// re-fetch a key it has, and the surrounding routing would then treat the
    /// device as newly unlocked — the account is at 21 of 50 devices and a
    /// duplicate is permanent. So this resolves to the existing registration:
    /// no camera, no core call, no request.
    ///
    /// A keychain read that **throws** is not "no key" —
    /// `errSecInteractionNotAllowed` is a phone not unlocked since boot — and
    /// answering "already linked" to it would strand the only screen that
    /// could recover. "Could not tell" therefore answers `false`, exactly as
    /// `AuthStartup.isAlreadyUnlocked()` does.
    func begin() {
        if holdsMasterKey() {
            phase = .alreadyLinked
            Log.auth.notice("device linking skipped: this phone already holds the master key")
        }
    }

    private func holdsMasterKey() -> Bool {
        do {
            return try secureStore.get(key: .masterKey) != nil
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.secureStore.error("could not tell whether the master key is present", .code(mapped.code))
            return false
        }
    }

    // MARK: - The camera path

    /// Asks for the camera, then scans. Two calls, because the seam's `scan()`
    /// never prompts — the trait has a separate `requestPermission` and a scan
    /// that prompted would put a system alert up at a moment nobody chose.
    ///
    /// A camera that cannot be used renders as the reason it cannot be used.
    /// It must never render as "no code found": an absent scanner and an
    /// unreadable code are different facts, and the manual field stays offered
    /// either way.
    func scanWithCamera() async {
        guard !isWorking, phase != .alreadyLinked else { return }
        error = nil
        switch await capture.requestPermission() {
        case .granted: break
        case .restricted: return record(CaptureError.Restricted, phase: .idle)
        case .denied, .notAsked: return record(CaptureError.NotPermitted, phase: .idle)
        }
        phase = .scanning
        do {
            let payload = try await capture.scan()
            await submit(payload)
        } catch {
            record(error, phase: .idle)
        }
    }

    /// Stops a running camera scan. The seam resumes its own suspended call
    /// with `CaptureError.Cancelled`, which is silent copy: the user's own
    /// decision is not news.
    func stopScanning() {
        guard phase == .scanning else { return }
        capture.cancel()
    }

    // MARK: - The manual path

    /// The fallback, and it is the real one. Handed over **verbatim**: the
    /// core is the parser (Constitution I), and a shell that trimmed or
    /// pre-judged the string would be a second, weaker parser of a
    /// security-relevant format.
    func submitTypedPayload() async {
        guard canSubmitTypedPayload else { return }
        await submit(typedPayload)
    }

    private func submit(_ payload: String) async {
        // The T154 edge again, at the last gate before a request. A phone that
        // acquired the key between `begin()` and here still must not link.
        guard !holdsMasterKey() else {
            phase = .alreadyLinked
            Log.auth.notice("device linking refused: this phone already holds the master key")
            return
        }
        error = nil
        phase = .submitting
        do {
            let scan = try await link.scan(qrPayload: payload)
            sasCode = scan.sasCode
            expiresAt = scan.expiresAt
            typedPayload = ""
            phase = .confirming
            Log.auth.notice("device linking scan accepted")
            startPolling()
        } catch let raised as LinkingError {
            record(raised, phase: phaseAfterScanFailure(raised))
        } catch {
            record(error, phase: .failed)
        }
    }

    /// A code that was never readable leaves the user on the scan screen,
    /// because scanning again is the fix. Everything else ends the attempt.
    private func phaseAfterScanFailure(_ raised: LinkingError) -> Phase {
        switch raised {
        case .InvalidQrPayload, .InvalidBase64, .InvalidLength: .idle
        case .SessionExpired: .expired
        default: .failed
        }
    }

    // MARK: - The poll

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let wait = await self?.pollTick() else { return }
                do { try await Task.sleep(for: wait) } catch { return }
            }
        }
    }

    /// One `POST /auth/linking/complete`, and how long to wait before the
    /// next. `nil` ends the loop.
    ///
    /// Separate from the loop so the cadence is assertable without a clock: a
    /// test reads the returned wait rather than measuring one.
    func pollTick() async -> Duration? {
        guard phase == .confirming else { return nil }
        do {
            switch try await link.pollOnce() {
            case .awaitingApproval:
                return Self.pollInterval
            case let .linked(vaults):
                self.vaults = vaults
                isLinked = true
                phase = .linked
                Log.auth.notice("vault unlocked by device linking", .count(vaults.count))
                return nil
            }
        } catch let raised as LinkingError {
            return waitAfter(raised)
        } catch {
            record(error, phase: .failed)
            return nil
        }
    }

    /// §3.4: the budget refusal costs no request, carries the wait the core
    /// computed, and is not a failure of the link — so it is logged and waited
    /// out rather than shown. Every other refusal ends the poll.
    private func waitAfter(_ raised: LinkingError) -> Duration? {
        if case let .PollBudgetExhausted(retryInMs) = raised {
            Log.auth.notice("device linking poll deferred", .code(ErrorMapping.userFacing(raised).code))
            return .milliseconds(retryInMs)
        }
        if case .SessionExpired = raised {
            record(raised, phase: .expired)
            return nil
        }
        record(raised, phase: .failed)
        return nil
    }

    // MARK: - Ending

    /// The abandonment path, and the only one there is.
    ///
    /// It stops the timer and calls the blocking `cancel()`, which zeroes the
    /// shared secret's three subkeys. It does **not** claim to stop a call in
    /// flight: `rust_future_cancel` appears zero times in the bindings, so a
    /// `pollOnce` already suspended runs to completion and its answer lands on
    /// a session this has already cleared.
    func stop() async {
        pollTask?.cancel()
        pollTask = nil
        // Blocking, so the executor, not the main actor (spec-defect 90).
        try? await executor.run { [link] in link.cancel() }
        sasCode = nil
        expiresAt = nil
        phase = .idle
        Log.auth.notice("device linking abandoned")
    }

    /// Back to a scannable state after a refusal or an expiry, with the reason
    /// cleared. The session, if any, is dropped rather than left pending.
    func startOver() async {
        error = nil
        await stop()
    }

    private func record(_ raised: any Error, phase next: Phase) {
        let mapped = ErrorMapping.userFacing(raised)
        Log.auth.error("device linking failed", .code(mapped.code))
        error = mapped.isUserVisible ? mapped : nil
        phase = next
    }
}
