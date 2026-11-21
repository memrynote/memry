import Foundation
import MemryCore

// Desktop's sync telemetry (`sync-run-outcome.ts`, `sync-error-telemetry.ts`,
// `bootstrap-metrics.ts`) for the iOS pass. An iOS pass pulls then pushes,
// which is desktop's `full` run.

enum SyncTelemetry {
    static func passCompleted(_ pass: SyncPassSummary, since start: ContinuousClock.Instant) {
        Telemetry.shared.track(
            .syncRunCompleted,
            surface: .sync,
            action: "full_completed",
            source: "full",
            result: pass.rejected > 0 ? .failed : .success,
            dimension: (.transport, "record"),
            metrics: TelemetryMetrics(
                durationMs: durationMs(since: start),
                itemCount: Double(pass.pulled) + Double(pass.pushed),
                queueCount: Double(pass.pending)
            )
        )
    }

    static func passFailed(_ error: any Error, since start: ContinuousClock.Instant) {
        guard !(error is CancellationError) else { return }
        let mapped = ErrorMapping.userFacing(error)
        let failure = failure(for: error, retryable: mapped.recourse != .blocked)
        Log.sync.error("sync pass failed", .code(mapped.code))
        if let status = failure.httpStatus { Log.sync.error("sync pass failed with status", .status(status)) }
        Telemetry.shared.track(
            .syncError,
            surface: .sync,
            action: "full_failed",
            source: "full",
            result: .failed,
            errorCode: mapped.code,
            dimension: (.transport, "record"),
            metrics: TelemetryMetrics(durationMs: durationMs(since: start)),
            failure: failure
        )
    }

    /// The first sync of a vault this phone never had: desktop's
    /// `vault_download` bootstrap, which is interactive once it ends.
    static func bootstrapInteractive(_ summary: FirstSyncSummary, since start: ContinuousClock.Instant) {
        Telemetry.shared.track(
            .syncBootstrap,
            surface: .sync,
            action: "interactive",
            source: "vault_download",
            result: .success,
            metrics: TelemetryMetrics(
                durationMs: durationMs(since: start),
                itemCount: Double(summary.recordsApplied)
            )
        )
    }

    /// Whether the open vault syncs: an account vault does, the local one
    /// the account does not hold does not.
    static func vaultOpened(syncs: Bool) {
        Task { await Telemetry.shared.setSyncState(syncs ? .enabled : .disabled) }
        if syncs {
            Telemetry.shared.track(.syncEnabled, surface: .sync, action: "enabled", result: .success)
        }
    }

    static func failure(for error: any Error, retryable: Bool) -> TelemetryFailure {
        var failure = TelemetryFailure(retryable: retryable)
        switch apiError(error) {
        case let .Status(status, code, _)?:
            if (100 ... 599).contains(status) { failure.httpStatus = Int(status) }
            failure.serverCode = ErrorMapping.serverCode(code)
        case let .Unauthorized(code, _)?:
            failure.httpStatus = 401
            failure.serverCode = ErrorMapping.serverCode(code)
        case let .PaymentRequired(code, _)?:
            failure.httpStatus = 402
            failure.serverCode = ErrorMapping.serverCode(code)
        case .RateLimited?:
            failure.httpStatus = 429
        default:
            break
        }
        return failure
    }

    private static func apiError(_ error: any Error) -> ApiError? {
        if let api = error as? ApiError { return api }
        if case let .Api(source) = error as? SyncError { return source }
        if case let .Api(source) = error as? AuthError { return source }
        return nil
    }

    private static func durationMs(since start: ContinuousClock.Instant) -> Double {
        ((ContinuousClock.now - start) / .milliseconds(1)).rounded()
    }
}

extension FirstSyncSummary {
    /// Records the run applied, whichever path brought them: record packs,
    /// the manifest reconcile, or the metadata pass.
    var recordsApplied: UInt32 {
        metadataApplied + recordPackEntries + reconcilePulled
    }
}
