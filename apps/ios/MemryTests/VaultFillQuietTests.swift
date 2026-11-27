import Foundation
import MemryCore
import SwiftUI
import Synchronization
import Testing
import UIKit

@testable import Memry

// #5247 (C50.2): the core sends no tick while a rate-limited body manifest
// page waits up to 60 s, so the strip said nothing for that long. After
// `quietAfter` with no tick it says the run is still going. The pause is
// ended by the test, never by a wall clock.

/// The quiet timer's pause, ended only by ``elapse()``. Newest first, so a
/// stale pause wakes last, the order FIFO resumption hid.
private final class TestPauses: @unchecked Sendable {
    private let waiting = Mutex<[CheckedContinuation<Void, Never>]>([])

    var count: Int { waiting.withLock { $0.count } }

    func pause(_: Duration) async throws {
        await withCheckedContinuation { continuation in
            waiting.withLock { $0.append(continuation) }
        }
    }

    func elapse() {
        let all = waiting.withLock { held in
            defer { held = [] }
            return held
        }
        for continuation in all.reversed() { continuation.resume() }
    }
}

/// A first sync whose ticks the test sends one at a time, held until
/// ``finish()``.
private final class TickedFiller: VaultFilling, @unchecked Sendable {
    private let send = Mutex<(@MainActor @Sendable (SyncProgress) -> Void)?>(nil)
    private let release = Mutex<CheckedContinuation<Void, Never>?>(nil)

    var isHeld: Bool { release.withLock { $0 != nil } }

    @MainActor func tick(_ progress: SyncProgress) {
        send.withLock { $0 }?(progress)
    }

    func finish() {
        release.withLock { held in
            held?.resume()
            held = nil
        }
    }

    func isFirstSyncComplete() async throws -> Bool { false }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        send.withLock { $0 = progress }
        await withCheckedContinuation { continuation in
            release.withLock { $0 = continuation }
        }
        return .applied(0)
    }

    func drainBodies(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> BodyDrainSummary {
        .round(0, remaining: 0)
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}

/// Bounded: two seconds of yields, then the caller's expectation fails.
@MainActor
private func settle(until done: @MainActor () -> Bool) async throws {
    for _ in 0..<200 where !done() {
        try await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
@Suite("#5247 the strip during a silent wait", .serialized)
struct VaultFillQuietTests {
    @Test("no tick for a while says the run is still going, and the next tick clears it")
    func aSilentWaitIsShown() async throws {
        let pauses = TestPauses()
        let filler = TickedFiller()
        let fill = VaultFillViewModel(filler: filler, pause: pauses.pause)
        let run = Task { await fill.begin() }
        try await settle { filler.isHeld }
        #expect(filler.isHeld)

        filler.tick(SyncProgress(phase: .records, completed: 1200, total: 1200))
        #expect(fill.strip != nil)
        #expect(!fill.isQuiet, "a tick that just arrived is not a silence")

        // The run's start and the tick each began a pause.
        try await settle { pauses.count == 2 }
        pauses.elapse()
        try await settle { fill.isQuiet }
        #expect(fill.isQuiet, "the same count for the whole pause says the run is still going")

        filler.tick(SyncProgress(phase: .bodies, completed: 3, total: 1200))
        #expect(!fill.isQuiet, "a new tick ends the silence")

        try await settle { pauses.count == 1 }
        pauses.elapse()
        try await settle { fill.isQuiet }
        #expect(fill.isQuiet)

        filler.finish()
        await run.value
        // The drain's start began one more pause; end it so nothing leaks.
        try await settle { pauses.count == 1 }
        pauses.elapse()
        #expect(fill.strip == nil)
        #expect(!fill.isQuiet, "a run that ended has nothing to wait on")
    }

    // REVIEW-5544: "Still working" made the body-phase line wrap on an iPhone,
    // so the list under the strip jumped a line on each quiet flip.
    @Test(
        "the strip keeps its height when it says the run is still going",
        arguments: [DynamicTypeSize.large, .accessibility5]
    )
    func theStripKeepsItsHeight(size: DynamicTypeSize) throws {
        let progress = SyncProgress(phase: .bodies, completed: 5100, total: 9677)
        let loud = try strip(progress, quiet: false, size: size)
        let quiet = try strip(progress, quiet: true, size: size)
        #expect(loud.size.height == quiet.size.height)
    }
}

/// The strip at an iPhone 17's width (402 pt), recorded for the PR.
@MainActor
private func strip(_ progress: SyncProgress, quiet: Bool, size: DynamicTypeSize) throws -> UIImage {
    let view = FirstSyncStrip(progress: progress, quiet: quiet)
        .environment(\.dynamicTypeSize, size)
        .background(Color.white)
    let renderer = ImageRenderer(content: view)
    renderer.proposedSize = ProposedViewSize(width: 402, height: nil)
    renderer.scale = 3
    let image = try #require(renderer.uiImage)
    if let png = image.pngData() {
        Attachment.record(png, named: "strip-\(size)-\(quiet ? "quiet" : "ticking").png")
    }
    return image
}
