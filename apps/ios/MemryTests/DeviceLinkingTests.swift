import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T153/T154. The linking flow's behaviour, behind substituted platforms.
//
// **What this file does not prove.** Every dependency here is a fake, so
// nothing below can tell "wired to the core" from "wired to something that
// behaves like it". That is `DeviceLinkWiringTests.swift`'s job and it is
// written to fail against a fake that works. These are the state machine, the
// cadence, and the four refusals that must never collapse into each other.
//
// **The camera does not exist on a simulator**, so every camera path here runs
// through a substituted `CodeCapture`. A simulator run evidences the shell's
// decisions about permission and cancellation; it evidences nothing about
// `AVCaptureMetadataOutput`, which is T161/T162's device run.

// MARK: - The core, replaced

/// A `DeviceLink` that answers from a script and counts what it was asked.
private final class ScriptedDeviceLink: DeviceLinkProtocol, @unchecked Sendable {
    struct Scanned: Sendable { let payload: String }

    let scans = Mutex<[Scanned]>([])
    let cancels = Mutex<Int>(0)
    private let scanAnswer: @Sendable () throws -> LinkingScan
    private let pollAnswers: Mutex<[Result<LinkingPoll, LinkingError>]>

    init(
        scan: @escaping @Sendable () throws -> LinkingScan = {
            LinkingScan(sessionId: "session", sasCode: "246801", expiresAt: 4_102_444_800)
        },
        polls: [Result<LinkingPoll, LinkingError>] = [.success(.awaitingApproval)]
    ) {
        scanAnswer = scan
        pollAnswers = Mutex(polls)
    }

    func scan(qrPayload: String) async throws -> LinkingScan {
        scans.withLock { $0.append(Scanned(payload: qrPayload)) }
        return try scanAnswer()
    }

    func pollOnce() async throws -> LinkingPoll {
        let next = pollAnswers.withLock { answers -> Result<LinkingPoll, LinkingError> in
            answers.isEmpty ? .success(.awaitingApproval) : answers.removeFirst()
        }
        return try next.get()
    }

    func cancel() { cancels.withLock { $0 += 1 } }

    func isPending() -> Bool { true }
}

/// A `CodeCapture` that never touches a camera.
private final class ScriptedCapture: CodeCapture, @unchecked Sendable {
    let scanCount = Mutex<Int>(0)
    let cancels = Mutex<Int>(0)
    private let granted: CapturePermission
    private let payload: Result<String, CaptureError>

    init(granted: CapturePermission = .granted, payload: Result<String, CaptureError> = .success("scanned-payload")) {
        self.granted = granted
        self.payload = payload
    }

    func permission() async -> CapturePermission { granted }
    func requestPermission() async -> CapturePermission { granted }

    func scan() async throws -> String {
        scanCount.withLock { $0 += 1 }
        return try payload.get()
    }

    func cancel() { cancels.withLock { $0 += 1 } }
}

/// An in-memory `SecureStore`. Correct, and therefore useless for the wiring
/// question — see the file comment.
private final class MemoryStore: SecureStore, @unchecked Sendable {
    private let entries = Mutex<[String: Data]>([:])

    init(masterKey: Data? = nil) {
        if let masterKey { entries.withLock { $0["master-key"] = masterKey } }
    }

    func get(key: SecureStoreKey) throws -> Data? { entries.withLock { $0[name(key)] } }
    func set(key: SecureStoreKey, value: Data) throws { entries.withLock { $0[name(key)] = value } }
    func delete(key: SecureStoreKey) throws { entries.withLock { $0[name(key)] = nil } }
    func clear() throws { entries.withLock { $0 = [:] } }

    private func name(_ key: SecureStoreKey) -> String {
        switch key {
        case .masterKey: "master-key"
        case .deviceSigningKey: "device-signing-key"
        case .accessToken: "access-token"
        case .refreshToken: "refresh-token"
        case .setupToken: "setup-token"
        }
    }
}

@MainActor
private func makeModel(
    link: ScriptedDeviceLink = ScriptedDeviceLink(),
    capture: ScriptedCapture = ScriptedCapture(),
    store: MemoryStore = MemoryStore(),
    now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 4_102_444_500) }
) -> DeviceLinkingViewModel {
    DeviceLinkingViewModel(
        link: link,
        capture: capture,
        secureStore: store,
        executor: CoreExecutor(label: "t153-tests"),
        now: now
    )
}

@Suite("device linking", .serialized)
struct DeviceLinkingTests {
    // MARK: - T154, the code itself

    /// The SAS is compared across two screens by ear as often as by eye, and
    /// VoiceOver reads `246801` as "two hundred forty-six thousand eight
    /// hundred one", which cannot be checked against anything.
    @Test("the verification code is spelled out one digit at a time")
    func theCodeIsSpelledOut() {
        #expect(VerificationCode.spokenLabel("246801") == "Verification code 2, 4, 6, 8, 0, 1")
    }

    /// §3.4's window is the server's, so the screen renders the server's
    /// `expiresAt` and never a hardcoded 300.
    @Test("the window is read from the server's expiresAt, in whole minutes")
    @MainActor
    func theWindowComesFromTheServer() async {
        let link = ScriptedDeviceLink(scan: {
            LinkingScan(sessionId: "s", sasCode: "111111", expiresAt: 1_000_300)
        })
        let model = makeModel(link: link, now: { Date(timeIntervalSince1970: 1_000_100) })
        model.typedPayload = "payload"
        await model.submitTypedPayload()

        #expect(model.expiresAt == 1_000_300)
        #expect(model.minutesRemaining == 4)
        #expect(SASConfirmView.windowText(minutes: 4) == "This code expires in about 4 minutes.")
        #expect(SASConfirmView.windowText(minutes: 1) == "This code expires in about a minute.")
        // Closed, but no poll has said so yet: never "0 minutes".
        #expect(SASConfirmView.windowText(minutes: nil) == "This code is about to expire.")
    }

    // MARK: - The poll, and §3.4's budget

    /// Desktop polls every 3 s, which is 20 requests per 60 s against a cap of
    /// 30. The cadence is asserted as the value the loop waits, not measured.
    @Test("an unapproved poll waits three seconds, which is inside §3.4's budget")
    @MainActor
    func theCadenceStaysInsideTheBudget() async {
        let model = makeModel()
        model.typedPayload = "payload"
        await model.submitTypedPayload()

        #expect(await model.pollTick() == .seconds(3))
        // 20 requests in the 60 s window §3.4 counts over, against its 30.
        #expect(60 / 3 <= 30)
    }

    /// The core refuses **before** it spends a request and says how long to
    /// wait. Honouring that number is the whole point: polling harder is what
    /// turns a client-side refusal into a 429 that spends the session.
    @Test("a budget refusal waits exactly the retryInMs the core computed, and is not shown as a failure")
    @MainActor
    func theBudgetRefusalIsHonoured() async {
        let link = ScriptedDeviceLink(polls: [.failure(.PollBudgetExhausted(retryInMs: 4500))])
        let model = makeModel(link: link)
        model.typedPayload = "payload"
        await model.submitTypedPayload()

        #expect(await model.pollTick() == .milliseconds(4500))
        // Still polling, and nothing alarming on screen: this is not a failure
        // of the link.
        #expect(model.phase == .confirming)
        #expect(model.error == nil)
    }

    @Test("an approval ends the poll and hands the vault list on")
    @MainActor
    func anApprovalEndsTheFlow() async {
        let vault = VaultSummary(id: "v1", name: "Work")
        let link = ScriptedDeviceLink(polls: [.success(.linked(vaults: [vault]))])
        let model = makeModel(link: link)
        model.typedPayload = "payload"
        await model.submitTypedPayload()

        #expect(await model.pollTick() == nil)
        #expect(model.phase == .linked)
        #expect(model.isLinked)
        #expect(model.vaults.map(\.id) == ["v1"])
    }

    // MARK: - Four refusals, four renderings

    /// The rule the whole flow turns on: a malformed code, a wrong-length
    /// secret, a closed window and a peer that did not hold the shared secret
    /// are four facts about four next actions.
    @Test("a malformed code, a wrong size, an expiry and a refused link are four different screens")
    @MainActor
    func fourRefusalsStayApart() async {
        let malformed = await refusal(.InvalidQrPayload(what: "sessionId"))
        let wrongSize = await refusal(.InvalidLength(what: "linkingSecret", expected: 32, actual: 16))
        let expired = await refusal(.SessionExpired)
        let refused = await refusal(.ConfirmMacInvalid)

        #expect(malformed.code == "linking.invalidQrPayload")
        #expect(wrongSize.code == "linking.invalidLength")
        #expect(expired.code == "linking.sessionExpired")
        #expect(refused.code == "linking.confirmMacInvalid")
        #expect(Set([malformed.code, wrongSize.code, expired.code, refused.code]).count == 4)
        // And the phases differ too: a code that can be scanned again leaves
        // the user on the scanner; the other two do not.
        #expect(malformed.phase == .idle)
        #expect(wrongSize.phase == .idle)
        #expect(expired.phase == .expired)
        #expect(refused.phase == .failed)
        // A permanent refusal is never described as a retry of the same code.
        #expect(refused.recourse == .blocked)
    }

    /// An expiry reported by the poll rather than by the scan: still its own
    /// state, and still not a failure of the user's eyesight.
    @Test("a session that expires while waiting reaches its own state")
    @MainActor
    func anExpiryWhileWaitingIsItsOwnState() async {
        let link = ScriptedDeviceLink(polls: [.failure(.SessionExpired)])
        let model = makeModel(link: link)
        model.typedPayload = "payload"
        await model.submitTypedPayload()

        #expect(await model.pollTick() == nil)
        #expect(model.phase == .expired)
        #expect(model.error?.code == "linking.sessionExpired")
    }

    /// What one refused scan left on screen.
    struct Refusal {
        let code: ErrorCode
        let phase: DeviceLinkingViewModel.Phase
        let recourse: UserFacingError.Recourse
    }

    @MainActor
    private func refusal(_ raised: LinkingError) async -> Refusal {
        let link = ScriptedDeviceLink(scan: { throw raised })
        let model = makeModel(link: link)
        model.typedPayload = "payload"
        await model.submitTypedPayload()
        let error = model.error
        return Refusal(code: error?.code ?? "none", phase: model.phase, recourse: error?.recourse ?? .retry)
    }

    // MARK: - T154's edge case

    /// FR-020's edge: a scan by a device that is **already linked** must
    /// resolve to the existing registration rather than mint a duplicate. The
    /// core has no opinion here — `scan` refuses only a second *pending*
    /// session — so the shell is what must not start one.
    @Test("a phone that already holds the master key never scans and never calls the core")
    @MainActor
    func anAlreadyLinkedPhoneDoesNotLinkAgain() async {
        let link = ScriptedDeviceLink()
        let capture = ScriptedCapture()
        let store = MemoryStore(masterKey: Data(repeating: 7, count: 32))
        let model = makeModel(link: link, capture: capture, store: store)

        model.begin()
        #expect(model.phase == .alreadyLinked)

        // Every road in, refused at the same gate.
        model.typedPayload = "payload"
        await model.submitTypedPayload()
        await model.scanWithCamera()

        #expect(model.phase == .alreadyLinked)
        #expect(link.scans.withLock(\.count) == 0)
        #expect(capture.scanCount.withLock { $0 } == 0)
    }

    // MARK: - Abandonment

    /// An in-flight core call cannot be cancelled (spec-defect 108), so what a
    /// user gets is a stop that stops the *timer* and zeroes the subkeys.
    @Test("stopping cancels the session through the core and returns to the scanner")
    @MainActor
    func stoppingCancelsTheSession() async {
        let link = ScriptedDeviceLink()
        let model = makeModel(link: link)
        model.typedPayload = "payload"
        await model.submitTypedPayload()
        #expect(model.phase == .confirming)

        await model.stop()

        #expect(link.cancels.withLock { $0 } == 1)
        #expect(model.phase == .idle)
        #expect(model.sasCode == nil)
        // And a poll after a stop makes no request at all.
        #expect(await model.pollTick() == nil)
    }

    // MARK: - The camera, and the fallback that is not one

    /// The seam's `scan()` never prompts, so the flow asks first. A camera
    /// that cannot be used must render as *why* — never as "no code found",
    /// which is the unparseable-reads-as-benign bug wearing a hat.
    @Test("a refused camera says which refusal it was, and never that no code was found")
    @MainActor
    func aRefusedCameraSaysWhy() async {
        let denied = ScriptedCapture(granted: .denied)
        let deniedModel = makeModel(capture: denied)
        await deniedModel.scanWithCamera()

        let restricted = ScriptedCapture(granted: .restricted)
        let restrictedModel = makeModel(capture: restricted)
        await restrictedModel.scanWithCamera()

        #expect(deniedModel.error?.code == "capture.notPermitted")
        #expect(restrictedModel.error?.code == "capture.restricted")
        // The two are not the same sentence: one can be granted in Settings
        // and one cannot.
        #expect(deniedModel.error?.guidance != restrictedModel.error?.guidance)
        // The camera was never touched.
        #expect(denied.scanCount.withLock { $0 } == 0)
        #expect(restricted.scanCount.withLock { $0 } == 0)
        // And the manual path is still open, which is the point of R13.
        deniedModel.typedPayload = "payload"
        #expect(deniedModel.canSubmitTypedPayload)
    }

    /// The manual path is the one CI and the simulator can take, so it must be
    /// the same call with the same bytes. Handed over **verbatim**: the core
    /// is the parser, and a shell that trimmed would be a second one.
    @Test("a typed payload reaches the core byte for byte")
    @MainActor
    func theTypedPayloadIsHandedOverVerbatim() async {
        let link = ScriptedDeviceLink()
        let model = makeModel(link: link)
        let payload = "  {\"sessionId\":\"s\"}\n"
        model.typedPayload = payload

        await model.submitTypedPayload()

        #expect(link.scans.withLock { $0.map(\.payload) } == [payload])
        // Cleared only on success, so a refusal leaves what the user pasted.
        #expect(model.typedPayload.isEmpty)
    }

    /// A decoded payload goes to the core unread — the seam's rule, and the
    /// reason the camera path and the typed path are the same call.
    @Test("a scanned payload is handed to the core unread")
    @MainActor
    func aScannedPayloadIsHandedOverUnread() async {
        let link = ScriptedDeviceLink()
        let capture = ScriptedCapture(payload: .success("not-json-at-all"))
        let model = makeModel(link: link, capture: capture)

        await model.scanWithCamera()

        #expect(link.scans.withLock { $0.map(\.payload) } == ["not-json-at-all"])
        #expect(model.phase == .confirming)
    }

    /// The user's own cancellation is silent copy: not alerted, still logged.
    @Test("cancelling a scan is not an error on screen")
    @MainActor
    func aCancelledScanIsSilent() async {
        let capture = ScriptedCapture(payload: .failure(.Cancelled))
        let model = makeModel(capture: capture)

        await model.scanWithCamera()

        #expect(model.error == nil)
        #expect(model.phase == .idle)
    }
}
