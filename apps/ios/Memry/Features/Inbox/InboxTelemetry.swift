import MemryCore

// Desktop parity for inbox and voice events (`ipc/inbox-handlers.ts`,
// `ipc/inbox-batch-handlers.ts`, `ipc/inbox-crud-handlers.ts`,
// `inbox/snooze.ts`, `inbox/capture.ts`, `inbox/jobs.ts`). A failure carries
// the mapped code of the error the store just reported.

/// A capture's type, as desktop's `capture_type` dimension names it.
enum InboxCaptureKind {
    case text, link, image, pdf, video, file, voice

    init(mime: String) {
        if mime.hasPrefix("image/") {
            self = .image
        } else if mime == "application/pdf" {
            self = .pdf
        } else if mime.hasPrefix("video/") {
            self = .video
        } else {
            self = .file
        }
    }

    var objectType: StaticString {
        switch self {
        case .text: "inbox_text"
        case .link: "inbox_link"
        case .image: "inbox_image"
        case .pdf: "inbox_pdf"
        case .video: "inbox_video"
        case .file: "inbox_file"
        case .voice: "inbox_voice"
        }
    }

    var token: String {
        switch self {
        case .text: "text"
        case .link: "link"
        case .image: "image"
        case .pdf: "pdf"
        case .video: "video"
        case .file: "file"
        case .voice: "voice"
        }
    }
}

extension InboxStore {
    private var failureCode: ErrorCode? { failure?.code }

    /// `source` is the capture's own `captureSource`; only the Share extension
    /// and Home's quick capture are named, as desktop names only the clipper.
    func trackCaptured(_ kind: InboxCaptureKind, source: String, ok: Bool) {
        let named: StaticString? = switch source {
        case "quick-capture": "share_extension"
        case "home": "home"
        default: nil
        }
        Telemetry.shared.track(
            .inboxCaptured, surface: .inbox, action: "captured", objectType: kind.objectType, source: named,
            result: ok ? .success : .failed, errorCode: ok ? nil : failureCode,
            dimension: (.captureType, kind.token)
        )
    }

    func trackFiled(_ filedAction: StaticString, ok: Bool) {
        Telemetry.shared.track(
            .inboxFiled, surface: .inbox, action: "filed",
            result: ok ? .success : .failed, errorCode: ok ? nil : failureCode,
            dimension: (.filedAction, filedAction.description)
        )
    }

    func trackArchived(ok: Bool) {
        Telemetry.shared.track(
            .inboxArchived, surface: .inbox, action: "archived",
            result: ok ? .success : .failed, errorCode: ok ? nil : failureCode
        )
    }

    func trackSnoozed(_ action: StaticString, ok: Bool) {
        Telemetry.shared.track(
            .inboxSnoozed, surface: .inbox, action: action,
            result: ok ? .success : .failed, errorCode: ok ? nil : failureCode
        )
    }

    /// One event per bulk call with the processed count (`trackBulk`).
    func trackBulk(_ name: TelemetryEventName, _ action: StaticString, source: StaticString = "bulk", processed: Int?) {
        Telemetry.shared.track(
            name, surface: .inbox, action: action, source: source,
            result: processed == nil ? .failed : .success, errorCode: processed == nil ? failureCode : nil,
            metrics: TelemetryMetrics(itemCount: Double(processed ?? 0))
        )
    }
}
