import AVFoundation
import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T146, the `CodeCapture` half.
//
// **Read `CameraPlatformTests` first.** It is the measurement the rest of this
// file is arranged around: this simulator has no camera at all, so every test
// that scans anything drives a substituted session, and none of them is
// evidence that AVFoundation does what this seam asks. What they *are* evidence
// of is the part that is this seam's own: the order of the calls (research
// R13), the debounce, the latch, and the permission mapping that must not
// collapse `Restricted` into `Denied`.
//
// **Nothing here waits for a callback that may never come** (spec-defect 99).
// The recording session delivers its payloads synchronously from
// `startRunning()`, which the seam calls only after the scan is claimable, so
// every scan test resolves inside the one `await` it makes. The time limits are
// backstops for a regression that breaks that ordering, never the mechanism.

private enum SessionStep: Equatable {
    case addCameraInput
    case addMetadataOutput
    case setMetadataObjectTypes([AVMetadataObject.ObjectType])
    case startRunning
    case stopRunning
}

/// Which configuration call refuses, for the failure arms.
private enum SessionFailure {
    case input
    case output
    case types
}

private final class RecordingSession: QRCaptureSession, @unchecked Sendable {
    let steps = Mutex<[SessionStep]>([])
    /// Delivered synchronously from `startRunning()`, in order.
    var payloads: [String?] = []
    var failing: SessionFailure?
    /// Runs after the payloads, while the scan is in flight. This is how a
    /// cancel is made to arrive at a defined moment rather than in a race.
    var onStart: (@Sendable () -> Void)?
    private let sink = Mutex<(@Sendable (String?) -> Void)?>(nil)

    var history: [SessionStep] {
        steps.withLock { $0 }
    }

    func addCameraInput() throws {
        steps.withLock { $0.append(.addCameraInput) }
        if failing == .input { throw CaptureError.Failed(what: "no camera") }
    }

    func addMetadataOutput(sink: @escaping @Sendable (String?) -> Void) throws {
        steps.withLock { $0.append(.addMetadataOutput) }
        if failing == .output { throw CaptureError.Failed(what: "no output") }
        self.sink.withLock { $0 = sink }
    }

    func setMetadataObjectTypes(_ types: [AVMetadataObject.ObjectType]) throws {
        steps.withLock { $0.append(.setMetadataObjectTypes(types)) }
        if failing == .types { throw CaptureError.Failed(what: "no qr") }
    }

    func startRunning() {
        steps.withLock { $0.append(.startRunning) }
        let deliver = sink.withLock { $0 }
        for payload in payloads {
            deliver?(payload)
        }
        onStart?()
    }

    func stopRunning() {
        steps.withLock { $0.append(.stopRunning) }
    }
}

private final class FakeAuthorization: CaptureAuthorizing, @unchecked Sendable {
    private let state: Mutex<CaptureAuthorizationStatus>
    /// What the platform decides once asked. `nil` leaves the status alone,
    /// which is what a decided status does.
    private let resolvesTo: CaptureAuthorizationStatus?
    private let grants: Bool
    let requests = Mutex(0)

    init(_ status: CaptureAuthorizationStatus, resolvesTo: CaptureAuthorizationStatus? = nil, grants: Bool = false) {
        state = Mutex(status)
        self.resolvesTo = resolvesTo
        self.grants = grants
    }

    func status() -> CaptureAuthorizationStatus {
        state.withLock { $0 }
    }

    func requestAccess() async -> Bool {
        requests.withLock { $0 += 1 }
        if let resolvesTo {
            state.withLock { $0 = resolvesTo }
        }
        return grants
    }
}

private final class EventRecorder: Sendable {
    let topics = Mutex<[CoreEvent.Topic]>([])

    var emitter: CoreEventEmitter {
        CoreEventEmitter { event in
            self.topics.withLock { $0.append(event.topic) }
        }
    }

    var history: [CoreEvent.Topic] {
        topics.withLock { $0 }
    }
}

/// The error a call threw, as a comparable value. Returns `nil` when nothing
/// was thrown, so a test asserts on the identity of the error and on the fact
/// that there was one in a single expression.
private func captureError(_ body: () async throws -> String) async -> CaptureError? {
    do {
        _ = try await body()
        return nil
    } catch let error as CaptureError {
        return error
    } catch {
        return .Failed(what: "an error that is not a CaptureError")
    }
}

@Suite("QRCodeScanner")
struct QRCodeScannerTests {
    private func scanner(
        _ authorization: FakeAuthorization,
        _ session: RecordingSession,
        _ events: EventRecorder = EventRecorder()
    ) -> QRCodeScanner {
        QRCodeScanner(emitter: events.emitter, authorization: authorization, makeSession: { session })
    }

    // MARK: - Permission

    /// The contract's `CapturePermission::Restricted` row: collapsing it sends
    /// a user to Settings to grant a permission an MDM profile will not let
    /// them grant.
    @Test("every authorization status maps to its own permission")
    func mapsEveryStatus() {
        let statuses: [CaptureAuthorizationStatus] = [
            .notDetermined, .authorized, .denied, .restricted, .unrecognized
        ]

        #expect(statuses.map(QRCodeScanner.map) == [.notAsked, .granted, .denied, .restricted, .denied])
    }

    /// **The identity test.** Both fakes answer `false` from `requestAccess`,
    /// which is exactly what the real `AVCaptureDevice` does for a denied
    /// camera and for a restricted one — so a seam that mapped that `Bool`
    /// would return the same value for both. These two differ, and the count of
    /// requests says why: neither was asked, because asking cannot tell them
    /// apart.
    @Test("restricted and denied are different answers, and neither is asked for")
    func keepsRestrictedApartFromDenied() async {
        let restricted = FakeAuthorization(.restricted, grants: false)
        let denied = FakeAuthorization(.denied, grants: false)
        let restrictedScanner = scanner(restricted, RecordingSession())
        let deniedScanner = scanner(denied, RecordingSession())

        let restrictedAnswer = await restrictedScanner.requestPermission()
        let deniedAnswer = await deniedScanner.requestPermission()

        #expect(restrictedAnswer == .restricted)
        #expect(deniedAnswer == .denied)
        #expect(restrictedAnswer != deniedAnswer)
        #expect(restricted.requests.withLock { $0 } == 0)
        #expect(denied.requests.withLock { $0 } == 0)
    }

    /// A profile can answer the prompt for the user. The status after the
    /// system replies is `.restricted`, and the `Bool` is `false` — the same
    /// `false` a denial returns.
    @Test("an undecided camera is answered from the status, not from the Bool")
    func readsTheStatusAfterAsking() async {
        let authorization = FakeAuthorization(.notDetermined, resolvesTo: .restricted, grants: false)
        let events = EventRecorder()
        let scanner = scanner(authorization, RecordingSession(), events)

        let answer = await scanner.requestPermission()

        #expect(answer == .restricted)
        #expect(authorization.requests.withLock { $0 } == 1)
        #expect(events.history == [.capturePermission])
    }

    @Test("granting an undecided camera reports granted and tells the UI once")
    func reportsAGrant() async {
        let authorization = FakeAuthorization(.notDetermined, resolvesTo: .authorized, grants: true)
        let events = EventRecorder()
        let scanner = scanner(authorization, RecordingSession(), events)

        #expect(await scanner.permission() == .notAsked)
        #expect(await scanner.requestPermission() == .granted)
        #expect(await scanner.permission() == .granted)
        // The read is a read: only the resolution is a hint.
        #expect(events.history == [.capturePermission])
    }

    /// Asking again after a decision changes nothing, so it announces nothing.
    @Test("a request that resolves to the same answer emits no hint")
    func staysQuietWithoutAChange() async {
        let events = EventRecorder()
        let scanner = scanner(FakeAuthorization(.denied), RecordingSession(), events)

        #expect(await scanner.requestPermission() == .denied)
        #expect(events.history.isEmpty)
    }

    // MARK: - Scanning

    /// **Research R13.** The output must be added to the session before
    /// `metadataObjectTypes` is set: a metadata output that is not attached yet
    /// has no available types, the assignment takes nothing, and the session
    /// then runs finding nothing with no error anywhere.
    ///
    /// Asserted as the whole history, so the order, the symbology asked for,
    /// and the stop after the hit are one assertion. A seam that set the types
    /// first fails on the order; one that asked for `.ean13` fails on the
    /// payload of `.setMetadataObjectTypes`.
    @Test("the output is added before the metadata types are set", .timeLimit(.minutes(1)))
    func addsTheOutputBeforeTheTypes() async throws {
        let session = RecordingSession()
        session.payloads = ["memry://link/abc"]
        let scanner = scanner(FakeAuthorization(.authorized), session)

        let payload = try await scanner.scan()

        #expect(payload == "memry://link/abc")
        #expect(session.history == [
            .addCameraInput,
            .addMetadataOutput,
            .setMetadataObjectTypes([.qr]),
            .startRunning,
            .stopRunning
        ])
    }

    /// Debounced to the first valid hit, then stopped. A QR code in frame is
    /// delivered at capture frame rate, so the second and later frames must
    /// take no path at all.
    @Test("the first valid hit wins and the camera stops once", .timeLimit(.minutes(1)))
    func debouncesToTheFirstHit() async throws {
        let session = RecordingSession()
        session.payloads = ["first", "second", "third"]
        let scanner = scanner(FakeAuthorization(.authorized), session)

        let payload = try await scanner.scan()

        #expect(payload == "first")
        #expect(session.history.filter { $0 == .stopRunning } == [.stopRunning])
    }

    /// A frame the camera did not resolve is not a code. Resolving it as an
    /// empty payload would hand the core an empty linking code to
    /// authenticate — the unparseable-reads-as-empty bug, in the one place it
    /// would reach a cryptographic parser.
    @Test("an unreadable or empty payload is not a hit", .timeLimit(.minutes(1)))
    func ignoresAnEmptyPayload() async throws {
        let session = RecordingSession()
        session.payloads = [nil, "", "memry://link/real"]
        let scanner = scanner(FakeAuthorization(.authorized), session)

        #expect(try await scanner.scan() == "memry://link/real")
    }

    /// Cancel arrives from the core, which is waiting on `scan()`; resuming
    /// that call is not a new entry into the core.
    @Test("a cancel ends the scan and stops the camera", .timeLimit(.minutes(1)))
    func cancels() async {
        let session = RecordingSession()
        let scanner = scanner(FakeAuthorization(.authorized), session)
        session.onStart = {
            scanner.cancel()
        }

        let error = await captureError { try await scanner.scan() }

        #expect(error == .Cancelled)
        #expect(session.history.last == .stopRunning)
    }

    /// The latch, from the other side: a cancel after the code was read finds
    /// nothing in flight, and must not stop a camera a second time or resume a
    /// continuation twice — the second resume would trap.
    @Test("a cancel after the hit does nothing", .timeLimit(.minutes(1)))
    func ignoresALateCancel() async throws {
        let session = RecordingSession()
        session.payloads = ["done"]
        let scanner = scanner(FakeAuthorization(.authorized), session)

        #expect(try await scanner.scan() == "done")
        scanner.cancel()

        #expect(session.history.filter { $0 == .stopRunning } == [.stopRunning])
    }

    /// A scan never prompts: the trait has a separate `request_permission`, so
    /// prompting here would put a system alert in front of a user at a moment
    /// the core did not choose. And the camera is not touched at all, which is
    /// also what keeps a missing `NSCameraUsageDescription` from terminating
    /// the process on a permission the app never had.
    @Test("a scan without permission is refused by its own reason, and touches no camera")
    func refusesWithoutPermission() async {
        let sessions = Mutex(0)
        let cases: [(CaptureAuthorizationStatus, CaptureError)] = [
            (.denied, .NotPermitted),
            (.restricted, .Restricted),
            (.notDetermined, .NotPermitted)
        ]

        for (status, expected) in cases {
            let scanner = QRCodeScanner(
                emitter: EventRecorder().emitter,
                authorization: FakeAuthorization(status),
                makeSession: {
                    sessions.withLock { $0 += 1 }
                    return RecordingSession()
                }
            )
            let error = await captureError { try await scanner.scan() }
            #expect(error == expected)
        }

        #expect(sessions.withLock { $0 } == 0)
    }

    /// A session that cannot be configured is reported, not run. The seam stops
    /// at the call that refused.
    @Test("a refused configuration is an error, not a session that finds nothing", .timeLimit(.minutes(1)))
    func reportsAConfigurationFailure() async {
        let session = RecordingSession()
        session.failing = .types
        let scanner = scanner(FakeAuthorization(.authorized), session)

        let error = await captureError { try await scanner.scan() }

        #expect(error == .Failed(what: "no qr"))
        #expect(session.history == [
            .addCameraInput,
            .addMetadataOutput,
            .setMetadataObjectTypes([.qr])
        ])
    }
}

/// What this platform actually does, measured rather than assumed
/// (spec-defect 104's family).
///
/// **Measured on the iPhone 17 simulator, iOS 26.5**, by asserting the opposite
/// and reading the failure:
///
///   * `AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position:
///     .back)` is `nil`;
///   * `AVCaptureDevice.devices(for: .video)` is `[]`;
///   * `AVCaptureDevice.authorizationStatus(for: .video)` is `.notDetermined`
///     (raw value 0) — the platform's untouched default, for a camera that does
///     not exist. **An assertion on the real status would therefore pass with
///     this seam's mapping deleted**, which is spec-defect 104's shape, so the
///     permission evidence in `QRCodeScannerTests` is all driven through a
///     substituted authorization instead.
///
/// There is no camera to authorize, to configure, or to run, so **no test in
/// this file is evidence that a QR code can be read on this platform**, and
/// none claims to be. Whether AVFoundation honours the call order this seam
/// makes is device evidence and belongs to T161/T162.
///
/// `requestAccess` is never called against the real platform anywhere in this
/// suite: it waits on a system prompt, and a test that waited on one would hang
/// rather than fail.
@Suite("Camera platform")
struct CameraPlatformTests {
    @Test("a platform with no camera is reported as one, rather than crashing")
    func reportsAMissingCamera() {
        let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        guard camera == nil else {
            // A real device. The success path is T161/T162's, and running it
            // here would open the camera during a unit test.
            return
        }

        let session = CameraCaptureSession()
        var thrown: CaptureError?
        do {
            try session.addCameraInput()
        } catch let error as CaptureError {
            thrown = error
        } catch {
            thrown = .Failed(what: "an error that is not a CaptureError")
        }

        #expect(thrown == .Failed(what: "this device has no camera"))
    }
}
