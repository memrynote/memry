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
    @Test("each bootstrap outcome is its own message with the HTTP status beside it")
    func bootstrapOutcomes() {
        let lines = Lines()
        let sink = lines.sink()
        let cases: [(BootstrapOutcome, UInt16)] = [
            (.granted, 200), (.notEligible, 409), (.sessionLimit, 429),
            (.notImplemented, 501), (.noToken, 200), (.failed, 0)
        ]
        for (outcome, status) in cases {
            sink.record(event: .bootstrapOpened(outcome: outcome, status: status))
        }
        #expect(lines.texts == [
            "core bootstrap granted [status=200]",
            "core bootstrap not eligible [status=409]",
            "core bootstrap session limit [status=429]",
            "core bootstrap not implemented [status=501]",
            "core bootstrap answered without a token [status=200]",
            "core bootstrap failed [status=0]"
        ])
    }

    @Test("a body pass reports its concurrency, window and skipped documents")
    func bodyPass() {
        let lines = Lines()
        lines.sink().record(event: .bodyPassStarted(
            elevated: false, concurrency: 1, documents: 500, upToDate: 120
        ))
        #expect(lines.texts == [
            "core body pass started [elevated=0 concurrency=1 documents=500 up_to_date=120]"
        ])
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

    @Test("every phase, running or ended, has its own message")
    func phaseMessagesAreDistinct() {
        let lines = Lines()
        let sink = lines.sink()
        let phases: [DiagnosticPhase] = [
            .recordPacks, .refs, .reconcile, .metadata, .bodyPacks, .bodies, .drainBodies
        ]
        for phase in phases {
            for finished in [true, false] {
                sink.record(event: .phaseStats(
                    phase: phase, finished: finished, elapsedMs: 0,
                    requests: RequestStats(
                        requests: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, retries: 0,
                        rateLimited: 0, rateLimitWaitMs: 0, serverErrors: 0, transportErrors: 0
                    )
                ))
            }
        }
        let messages = lines.texts.map { $0.components(separatedBy: " [").first ?? "" }
        #expect(messages.count == 14)
        #expect(Set(messages).count == 14)
        #expect(lines.levels.allSatisfy { $0 == .default })
    }

    @Test("a line holds nothing but literals and numbers")
    func linesAreBareIdentifiers() {
        let lines = Lines()
        lines.sink().record(event: .phaseStats(
            phase: .refs, finished: true, elapsedMs: UInt64.max,
            requests: RequestStats(
                requests: .max, p50Ms: .max, p95Ms: .max, maxMs: .max, retries: .max,
                rateLimited: .max, rateLimitWaitMs: .max, serverErrors: .max, transportErrors: .max
            )
        ))
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .=[]_-")
        for text in lines.texts {
            #expect(text.allSatisfy(allowed.contains), "unexpected characters in: \(text)")
        }
    }
}
