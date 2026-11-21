import MemryCore

// #5215. The Rust core writes no log of its own: it hands this sink typed
// numbers about a sync run (`CoreDiagnostic` has no string in it), and the
// words on each line are written here, one fixed `StaticString` per case. So
// what the core reports can reach `diagnostics.log` and a feedback email, but
// it cannot carry a note id, a title, a path, a key or a server message, and
// that is true by the shape of the type, not by anyone remembering it.
//
// Every line is `.notice`, the level that persists. Volume is the core's to
// bound: a phase reports once when it ends and at most every two minutes while
// it runs, and nothing is reported per request.

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
            log.notice(
                "core body pass started",
                Self.metric("elevated", elevated ? 1 : 0),
                Self.metric("concurrency", concurrency),
                Self.metric("documents", documents),
                Self.metric("up_to_date", upToDate)
            )
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
