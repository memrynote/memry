import MemryCore

// #5215. Maps the core's typed `CoreDiagnostic`s to fixed `Log.sync` lines; the
// privacy argument is in the core's `seams/diagnostics.rs`.

/// Writes the core's ``CoreDiagnostic`` events to `Log.sync`.
final class CoreDiagnostics: DiagnosticsSink {
    let log: Log

    init(log: Log = .sync) {
        self.log = log
    }

    /// Hands the core its sink. Once, at launch, before the first sync.
    static func register() {
        setDiagnosticsSink(sink: CoreDiagnostics())
    }

    func record(event: CoreDiagnostic) {
        switch event {
        case let .bootstrapOpened(outcome, status):
            log.notice(Self.message(for: outcome), .status(Int(status)))
        case let .bodyPassStarted(elevated, concurrency, documents, upToDate):
            let elevated = Self.metric("elevated", elevated ? 1 : 0)
            let concurrency = Self.metric("concurrency", concurrency)
            let documents = Self.metric("documents", documents)
            if let upToDate {
                log.notice(
                    "core body pass started", elevated, concurrency, documents,
                    Self.metric("up_to_date", upToDate)
                )
            } else {
                log.notice("core body pass started", elevated, concurrency, documents)
            }
        case let .phaseStats(phase, finished, elapsedMs, stats):
            log.notice(
                Self.message(for: phase, finished: finished),
                Self.metric("elapsed_ms", elapsedMs),
                Self.metric("requests", stats.requests),
                Self.metric("p50_ms", stats.p50Ms),
                Self.metric("p95_ms", stats.p95Ms),
                Self.metric("max_ms", stats.maxMs),
                Self.metric("retries", stats.retries),
                Self.metric("rate_limited", stats.rateLimited),
                Self.metric("rate_limit_wait_ms", stats.rateLimitWaitMs),
                Self.metric("server_errors", stats.serverErrors),
                Self.metric("transport_errors", stats.transportErrors)
            )
        case let .reconcileKept(kept, remembered, nonEnvelope, cursor):
            let counts = (
                Self.metric("kept", kept),
                Self.metric("remembered", remembered),
                Self.metric("non_envelope", nonEnvelope)
            )
            if let cursor {
                log.notice(
                    "core reconcile kept stale rows", counts.0, counts.1, counts.2,
                    Self.metric("cursor", max(cursor, 0))
                )
            } else {
                log.notice("core reconcile kept stale rows", counts.0, counts.1, counts.2)
            }
        case let .refsDeletesUnverified(unverified, cursor):
            if let cursor {
                log.notice(
                    "core refs deletes unverified",
                    Self.metric("unverified", unverified), Self.metric("cursor", max(cursor, 0))
                )
            } else {
                log.notice("core refs deletes unverified", Self.metric("unverified", unverified))
            }
        }
    }

    private static func metric(_ name: MetricName, _ value: some BinaryInteger) -> LogDetail {
        .metric(name, UInt64(value))
    }

    private static func message(for outcome: BootstrapOutcome) -> StaticString {
        switch outcome {
        case .granted: "core bootstrap granted"
        case .notEligible: "core bootstrap not eligible"
        case .sessionLimit: "core bootstrap session limit"
        case .notImplemented: "core bootstrap not implemented"
        case .noToken: "core bootstrap answered without a token"
        case .failed: "core bootstrap failed"
        }
    }

    private static func message(for phase: DiagnosticPhase, finished: Bool) -> StaticString {
        switch (phase, finished) {
        case (.recordPacks, true): "core record packs phase"
        case (.recordPacks, false): "core record packs phase so far"
        case (.refs, true): "core refs phase"
        case (.refs, false): "core refs phase so far"
        case (.reconcile, true): "core reconcile phase"
        case (.reconcile, false): "core reconcile phase so far"
        case (.metadata, true): "core metadata phase"
        case (.metadata, false): "core metadata phase so far"
        case (.bodyPacks, true): "core body packs phase"
        case (.bodyPacks, false): "core body packs phase so far"
        case (.bodies, true): "core bodies phase"
        case (.bodies, false): "core bodies phase so far"
        case (.drainBodies, true): "core body drain phase"
        case (.drainBodies, false): "core body drain phase so far"
        }
    }
}
