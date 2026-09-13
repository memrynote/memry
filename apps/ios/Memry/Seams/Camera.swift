import AVFoundation
import Foundation
import MemryCore
import Synchronization

/// T146. The `CodeCapture` seam
/// (`crates/memry-core/src/seams/capture.rs`, research R13).
///
/// Device linking scans a QR code. The camera, the permission and the decoder
/// are the platform's; **the decoded string is handed over unread**. Nothing
/// here validates it, trims it, or decides whether it looks like a linking
/// payload — the core parses and authenticates it (Constitution I), and a shell
/// that pre-judged the payload would be a second, weaker parser of a
/// security-relevant format.
///
/// **`Restricted` is not `Denied`, and this file is where the two stay apart.**
/// A restricted camera is one an MDM profile or parental controls forbid: the
/// user *cannot* grant it, so the Settings instruction a denial earns is the
/// wrong instruction for them (`contracts/shell-seams.md`, the
/// `CapturePermission::Restricted` row). The trap is
/// `AVCaptureDevice.requestAccess`, which returns `false` for both — so this
/// seam never maps that `Bool`. It reads `authorizationStatus`, which keeps the
/// two cases distinct, and it does not even ask when the status is already
/// decided. See ``requestPermission()``.
///
/// **Called from Rust, so it calls nothing back.** All four methods are
/// dispatched by UniFFI; the two that say something out loud say it through
/// ``CoreEventEmitter``, whose whole surface is a synchronous `Void` `emit`.
///
/// **`NSCameraUsageDescription` is present** in `Memry/Resources/Info.plist`
/// with the comment saying why: without it the first `AVCaptureDevice` access
/// terminates the process rather than returning an error.
final class QRCodeScanner: CodeCapture {
    /// One scan in flight. Held as a whole so that "who gets to resume" and
    /// "which session to stop" cannot drift apart: taking this out of the mutex
    /// is the latch, and the taker is the only caller that resumes.
    private struct Scan: Sendable {
        let resume: @Sendable (Result<String, CaptureError>) -> Void
        let session: any QRCaptureSession
    }

    private let emitter: CoreEventEmitter
    private let authorization: any CaptureAuthorizing
    private let makeSession: @Sendable () -> any QRCaptureSession
    private let inFlight = Mutex<Scan?>(nil)

    /// - Parameters:
    ///   - authorization: the two `AVCaptureDevice` authorization calls,
    ///     injected because a simulator cannot be made to report `.restricted`,
    ///     and because prompting for real inside a test hangs it.
    ///   - makeSession: the capture session, injected because **a simulator has
    ///     no camera at all** — `AVCaptureDevice.default(_:for:position:)`
    ///     returns `nil` there, so the real session can be built but never run
    ///     (spec-defect 104's family).
    init(
        emitter: CoreEventEmitter,
        authorization: any CaptureAuthorizing = SystemCaptureAuthorization(),
        makeSession: @escaping @Sendable () -> any QRCaptureSession = { CameraCaptureSession() }
    ) {
        self.emitter = emitter
        self.authorization = authorization
        self.makeSession = makeSession
    }

    // MARK: - Permission

    /// A read. Emits nothing: a read that announced a change would have the UI
    /// re-read on every poll.
    func permission() async -> CapturePermission {
        Self.map(authorization.status())
    }

    /// Asks, but only when asking can answer anything.
    ///
    /// `requestAccess` returns `false` for a denied camera **and** for a
    /// restricted one, and it returns immediately in both cases without showing
    /// anything. So a decided status is answered from the status itself, and a
    /// `.notDetermined` one is answered from the status *after* the system has
    /// replied — never from the `Bool`, which is exactly the collapse the
    /// contract forbids. Re-reading also catches the case where the answer is
    /// not the one the prompt offered: a profile that forbids the camera turns
    /// `.notDetermined` into `.restricted`, not into `.denied`.
    func requestPermission() async -> CapturePermission {
        let before = Self.map(authorization.status())
        guard before == .notAsked else {
            return before
        }
        _ = await authorization.requestAccess()
        let after = Self.map(authorization.status())
        if after != before {
            emitter.emit(CoreEvent(.capturePermission))
        }
        return after
    }

    /// The mapping, and the one arm worth arguing about.
    ///
    /// A status this build does not recognise is `.denied`: "not usable now,
    /// and the user's own action is what changes it". It is deliberately not
    /// `.notAsked`, which would read as "nothing has happened yet" — the shape
    /// of the unparseable-reads-as-empty bug — and deliberately not
    /// `.restricted`, which would claim a cause we did not observe and tell the
    /// user there is nothing they can do.
    static func map(_ status: CaptureAuthorizationStatus) -> CapturePermission {
        switch status {
        case .notDetermined: return .notAsked
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .unrecognized: return .denied
        }
    }

    // MARK: - Scanning

    /// Starts capture and resolves with the first decoded payload.
    ///
    /// **It never prompts.** The trait has a separate `request_permission`, so
    /// a scan that prompted would put a system alert in front of a user at a
    /// moment the core did not choose. A permission that is not `granted` is
    /// reported as the typed error for what it is, and the camera is not
    /// touched at all.
    func scan() async throws -> String {
        switch await permission() {
        case .granted: break
        case .restricted: throw CaptureError.Restricted
        case .denied, .notAsked: throw CaptureError.NotPermitted
        }

        let session = makeSession()
        // **Research R13, and the reason this is three calls and not one.** The
        // output must be added to the session *before* `metadataObjectTypes` is
        // set: a metadata output that is not attached yet has no available
        // types, so the assignment takes nothing, and the session then runs
        // forever finding nothing with no error anywhere. The order lives here,
        // in the seam, so that a test can assert it as a history.
        try session.addCameraInput()
        try session.addMetadataOutput { [weak self] payload in
            self?.decoded(payload)
        }
        try session.setMetadataObjectTypes([.qr])

        Log.capture.info("qr scan started")
        return try await withCheckedThrowingContinuation { continuation in
            let accepted = inFlight.withLock { current -> Bool in
                guard current == nil else { return false }
                current = Scan(
                    resume: { result in
                        switch result {
                        case let .success(payload): continuation.resume(returning: payload)
                        case let .failure(error): continuation.resume(throwing: error)
                        }
                    },
                    session: session
                )
                return true
            }
            guard accepted else {
                // Two scans at once is a caller error, not a camera failure,
                // and starting a second session would fight the first for the
                // device. The running scan is left alone.
                continuation.resume(throwing: CaptureError.Failed(what: "a scan is already running"))
                return
            }
            // Started only once the scan is claimable, so a payload the
            // platform delivers synchronously from `startRunning` still has
            // somewhere to land.
            session.startRunning()
        }
    }

    /// Called by the core when it no longer wants the scan. Reports nothing
    /// inline and calls nothing back: the waiting `scan()` is resumed, which is
    /// the core's own suspended call, not a new entry into it.
    ///
    /// A cancel arriving after a hit finds nothing in flight and does nothing.
    func cancel() {
        finish(.failure(.Cancelled))
    }

    /// One metadata object from the platform.
    ///
    /// **Debounced to the first valid hit** — `finish` latches, so the second
    /// and later frames of the same code, which arrive at capture frame rate,
    /// take no path at all.
    ///
    /// A `nil` or empty payload is **not** a hit and **not** a failure: a
    /// metadata object whose string could not be read is a frame the camera did
    /// not resolve, and resolving it as an empty payload would hand the core an
    /// empty linking code to authenticate. The scan keeps running, which is
    /// what a user pointing a camera at a code expects.
    private func decoded(_ payload: String?) {
        guard let payload, !payload.isEmpty else { return }
        finish(.success(payload))
    }

    /// The latch. Whoever takes the scan out is the one that stops the session
    /// and resumes the caller; everyone after gets `nil` and returns.
    ///
    /// `stopRunning` happens here rather than in the caller so that every way a
    /// scan can end — a hit, a cancel — stops the camera, and so that it cannot
    /// be stopped twice.
    private func finish(_ result: Result<String, CaptureError>) {
        let claimed = inFlight.withLock { current -> Scan? in
            let scan = current
            current = nil
            return scan
        }
        guard let claimed else { return }
        claimed.session.stopRunning()
        switch result {
        case .success: Log.capture.info("qr scan resolved")
        case .failure: Log.capture.notice("qr scan ended without a code")
        }
        claimed.resume(result)
    }
}

/// `AVAuthorizationStatus`, mirrored so that the `@unknown default` arm is a
/// case this seam's own mapping has to answer for, rather than a branch hidden
/// inside a `switch` no test can reach.
enum CaptureAuthorizationStatus: Sendable, Equatable {
    case notDetermined
    case authorized
    case denied
    case restricted
    /// A status this build does not know. See ``QRCodeScanner/map(_:)``.
    case unrecognized
}

/// The two authorization calls, behind a protocol because the simulator cannot
/// produce `.restricted` on demand and because a real `requestAccess` inside a
/// test waits on a system prompt that never gets answered.
protocol CaptureAuthorizing: Sendable {
    func status() -> CaptureAuthorizationStatus
    func requestAccess() async -> Bool
}

/// The real one.
struct SystemCaptureAuthorization: CaptureAuthorizing {
    func status() -> CaptureAuthorizationStatus {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: return .notDetermined
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .unrecognized
        }
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}

/// The capture session as the four calls a QR scan makes, in the order it makes
/// them.
///
/// Shaped like the AVFoundation calls rather than like a scanner — "add the
/// output", "set the types" — so that the ordering research R13 is about stays
/// visible in the seam and a substitute can record it. A protocol with one
/// `scanForQRCodes()` method would have hidden the exact thing this task exists
/// to get right.
protocol QRCaptureSession: AnyObject, Sendable {
    func addCameraInput() throws
    /// Adds the metadata output **and** attaches the sink. `nil` is delivered
    /// for a metadata object whose string could not be read.
    func addMetadataOutput(sink: @escaping @Sendable (String?) -> Void) throws
    /// Only meaningful once the output is attached. See R13.
    func setMetadataObjectTypes(_ types: [AVMetadataObject.ObjectType]) throws
    func startRunning()
    func stopRunning()
}

/// The real session. Every failure is a typed `CaptureError`; nothing here
/// renders a sentence for a human (Constitution II).
///
/// **Unexercised on a simulator**: `AVCaptureDevice.default(_:for:position:)`
/// returns `nil` there, so ``addCameraInput()`` throws before anything else in
/// this type runs. Device evidence belongs to T161/T162.
final class CameraCaptureSession: QRCaptureSession, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let output = AVCaptureMetadataOutput()
    /// The session's own queue. `startRunning()` blocks, and blocking a
    /// cooperative thread on it would stall unrelated work.
    private let queue = DispatchQueue(label: "com.memry.ios.capture", qos: .userInitiated)
    private var sink: MetadataSink?

    func addCameraInput() throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CaptureError.Failed(what: "this device has no camera")
        }
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            throw CaptureError.Failed(what: "the camera could not be opened")
        }
        session.addInput(input)
    }

    func addMetadataOutput(sink: @escaping @Sendable (String?) -> Void) throws {
        guard session.canAddOutput(output) else {
            throw CaptureError.Failed(what: "the camera could not be read")
        }
        session.addOutput(output)
        let delegate = MetadataSink(sink: sink)
        self.sink = delegate
        output.setMetadataObjectsDelegate(delegate, queue: queue)
    }

    /// Refuses rather than no-ops.
    ///
    /// `availableMetadataObjectTypes` is empty until the output is attached, so
    /// this guard is what turns research R13's silent failure — a session that
    /// runs and finds nothing, with no error anywhere — into a reported one.
    func setMetadataObjectTypes(_ types: [AVMetadataObject.ObjectType]) throws {
        let available = Set(output.availableMetadataObjectTypes)
        guard types.allSatisfy(available.contains) else {
            throw CaptureError.Failed(what: "this camera cannot read QR codes")
        }
        output.metadataObjectTypes = types
    }

    func startRunning() {
        queue.async { [weak self] in
            self?.session.startRunning()
        }
    }

    func stopRunning() {
        queue.async { [weak self] in
            self?.session.stopRunning()
        }
    }
}

/// The delegate, and the only place a metadata object is turned into a string.
///
/// Every object that is not a machine-readable QR code is skipped rather than
/// delivered as `nil`: this seam asked for `.qr` and nothing else, so an object
/// of another type is a frame to keep scanning past, not a code that failed to
/// read.
private final class MetadataSink: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    private let sink: @Sendable (String?) -> Void

    init(sink: @escaping @Sendable (String?) -> Void) {
        self.sink = sink
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for object in metadataObjects {
            guard let code = object as? AVMetadataMachineReadableCodeObject, code.type == .qr else { continue }
            sink(code.stringValue)
        }
    }
}
