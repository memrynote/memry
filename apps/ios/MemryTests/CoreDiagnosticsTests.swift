import Foundation
import MemryCore
import Testing
import os

@testable import Memry

// #5215. The core reports sync internals as typed numbers, and this sink turns
// each one into a `Log` line. What a feedback email shows is these lines, so
// the claim under test is the lines: one fixed message per case, the numbers
// beside it, and nothing else.

/// Collects what the sink handed `Log`.
private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [(OSLogType, String)] = []

    var texts: [String] { lock.withLock { captured.map(\.1) } }
    var levels: [OSLogType] { lock.withLock { captured.map(\.0) } }

    func sink() -> CoreDiagnostics {
        CoreDiagnostics(log: Log(capturing: { level, text in
            self.lock.withLock { self.captured.append((level, text)) }
        }))
    }
}

@Suite("CoreDiagnostics")
struct CoreDiagnosticsTests {
    @Test("a body pass reports its concurrency and window, and the skipped documents only when measured")
    func bodyPass() {
        let lines = Lines()
        let sink = lines.sink()
        sink.record(event: .bodyPassStarted(
            elevated: false, concurrency: 1, documents: 500, upToDate: 120
        ))
        sink.record(event: .bodyPassStarted(
            elevated: true, concurrency: 2, documents: 2, upToDate: nil
        ))
        #expect(lines.texts == [
            "core body pass started [elevated=0 concurrency=1 documents=500 up_to_date=120]",
            "core body pass started [elevated=1 concurrency=2 documents=2]"
        ])
    }

    @Test("a bootstrap outcome is its fixed message with the HTTP status beside it")
    func bootstrapOutcome() {
        let lines = Lines()
        lines.sink().record(event: .bootstrapOpened(outcome: .notEligible, status: 409))
        #expect(lines.texts == ["core bootstrap not eligible [status=409]"])
        #expect(lines.levels == [.default])
    }

    @Test("a phase reports its request statistics, retries and rate-limit wait")
    func phaseStats() {
        let lines = Lines()
        let sink = lines.sink()
        let stats = RequestStats(
            requests: 812, p50Ms: 140, p95Ms: 900, maxMs: 4_100, retries: 3,
            rateLimited: 2, rateLimitWaitMs: 4_000, serverErrors: 1, transportErrors: 0
        )
        sink.record(event: .phaseStats(phase: .bodies, finished: true, elapsedMs: 61_000, requests: stats))
        sink.record(event: .phaseStats(phase: .bodies, finished: false, elapsedMs: 120_000, requests: stats))
        func numbers(elapsed: Int) -> String {
            "elapsed_ms=\(elapsed) requests=812 p50_ms=140 p95_ms=900 max_ms=4100 retries=3 "
                + "rate_limited=2 rate_limit_wait_ms=4000 server_errors=1 transport_errors=0"
        }
        #expect(lines.texts == [
            "core bodies phase [\(numbers(elapsed: 61_000))]",
            "core bodies phase so far [\(numbers(elapsed: 120_000))]"
        ])
    }

    /// #5247: what first sync kept live, which stderr never showed on iOS.
    @Test("kept stale rows and open refs deletes report their counts and the cursor when known")
    func keptRows() {
        let lines = Lines()
        let sink = lines.sink()
        sink.record(event: .reconcileKept(kept: 3, remembered: 1, nonEnvelope: 0, cursor: 42))
        sink.record(event: .reconcileKept(kept: 1, remembered: 0, nonEnvelope: 1, cursor: nil))
        sink.record(event: .refsDeletes(unverified: 2, nonEnvelope: 0, cursor: 10))
        sink.record(event: .refsDeletes(unverified: 0, nonEnvelope: 1, cursor: nil))
        #expect(lines.texts == [
            "core reconcile kept stale rows [kept=3 remembered=1 non_envelope=0 cursor=42]",
            "core reconcile kept stale rows [kept=1 remembered=0 non_envelope=1]",
            "core refs deletes left open [unverified=2 non_envelope=0 cursor=10]",
            "core refs deletes left open [unverified=0 non_envelope=1]"
        ])
    }
}
