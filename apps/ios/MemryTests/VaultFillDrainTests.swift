import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #5233: the foreground drain of the bodies a first sync left owed, and the
// strip that counts it. `StoreFiller` (VaultFillTests.swift) scripts each
// round; no network call is made by this file.

private func bodies(_ done: UInt64, of total: UInt64) -> SyncProgress {
    SyncProgress(phase: .bodies, completed: done, total: total)
}

@MainActor
@Suite("#5233 the body drain", .serialized)
struct VaultFillDrainTests {
    @Test("rounds continue until nothing is owed, then the strip goes")
    func roundsRunUntilNothingIsOwed() async throws {
        let filler = StoreFiller(
            store: VaultStore(), fills: 3, summary: .applied(3),
            rounds: [
                ([bodies(400, of: 900)], .success(.round(400, remaining: 500))),
                ([bodies(800, of: 900)], .success(.round(400, remaining: 100))),
                ([bodies(900, of: 900)], .success(.round(100, remaining: 0))),
            ]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()

        #expect(filler.history == [.gate, .first, .drain, .drain, .drain])
        #expect(fill.phase == .filled)
        #expect(fill.strip == nil)
        // Ends for good: a later foreground asks for nothing.
        await fill.sceneChanged(active: true)
        #expect(filler.history.count == 5)
    }

    @Test("a vault already synced still drains what it owes")
    func theGateStillDrains() async throws {
        let filler = StoreFiller(
            store: VaultStore(), alreadyComplete: true,
            rounds: [([bodies(9, of: 10)], .success(.round(4, remaining: 0)))]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(filler.history == [.gate, .drain])
        #expect(fill.phase == .filled)
    }

    /// Owed documents backing off after a failure come back as `remaining`
    /// with nothing pulled; asking again at once would spin.
    @Test("a round that pulled nothing pauses the drain")
    func anEmptyRoundEndsTheDrain() async throws {
        let filler = StoreFiller(
            store: VaultStore(), alreadyComplete: true,
            rounds: [
                ([], .success(.round(0, remaining: 7))),
                ([], .success(.round(5, remaining: 0))),
            ]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(filler.history == [.gate, .drain])
    }

    /// A 429 or a lost network on a round's first document pulls nothing
    /// with bodies still owed. That pauses the drain; it does not end it.
    @Test("a round that pulled nothing with bodies owed resumes on the next foreground")
    func anEmptyRoundResumesOnForeground() async throws {
        let filler = StoreFiller(
            store: VaultStore(), alreadyComplete: true,
            rounds: [
                ([], .success(.round(0, remaining: 900))),
                ([], .success(.round(400, remaining: 0))),
            ]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(filler.history == [.gate, .drain])

        await fill.sceneChanged(active: false)
        await fill.sceneChanged(active: true)
        #expect(filler.history == [.gate, .drain, .drain])
        #expect(fill.phase == .filled)
    }

    @Test("a screen that goes away asks for no further round")
    func leavingEndsTheDrain() async throws {
        let filler = HeldDrainFiller(firstRound: .round(400, remaining: 500))
        let fill = VaultFillViewModel(filler: filler)
        let run = Task { await fill.begin() }
        for _ in 0..<200 where !filler.isHeld {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(filler.isHeld)
        fill.leave()
        filler.finish()
        await run.value
        #expect(filler.rounds == 1)
        #expect(fill.phase == .filled)
    }

    @Test("the strip keeps the first sync's count into the drain")
    func theStripCarriesIntoTheDrain() async throws {
        let filler = HeldDrainFiller(
            firstSyncTicks: [bodies(500, of: 900), SyncProgress(phase: .done, completed: 900, total: 900)],
            firstRoundTick: nil
        )
        let fill = VaultFillViewModel(filler: filler)
        let run = Task { await fill.begin() }
        for _ in 0..<200 where !filler.isHeld {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(filler.isHeld)
        #expect(fill.strip == bodies(500, of: 900), "no gap between the first sync and the drain")
        filler.finish()
        await run.value
        #expect(fill.strip == nil)
    }

    @Test("a failed round ends the drain quietly, and the bodies stay owed")
    func aFailedRoundIsQuiet() async throws {
        let filler = StoreFiller(
            store: VaultStore(), alreadyComplete: true,
            rounds: [([bodies(1, of: 10)], .failure(SyncError.Api(source: .Status(status: 503, code: nil, message: ""))))]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.begin()
        #expect(fill.phase == .filled)
        #expect(fill.banner == .none, "a drain failure is a log line, not a banner")
        #expect(fill.strip == nil)
    }

    @Test("no round in the background; the foreground continues the drain")
    func theBackgroundPausesTheDrain() async throws {
        let filler = StoreFiller(
            store: VaultStore(), fills: 1, summary: .applied(1),
            rounds: [([bodies(5, of: 5)], .success(.round(5, remaining: 0)))]
        )
        let fill = VaultFillViewModel(filler: filler)
        await fill.sceneChanged(active: false)
        await fill.begin()
        #expect(filler.history == [.gate, .first], "no round while in the background")

        await fill.sceneChanged(active: true)
        #expect(filler.history == [.gate, .first, .drain])
    }

    @Test("the drain does not hold the vault's sync passes")
    func theDrainIsNotPending() async throws {
        let filler = HeldDrainFiller()
        let fill = VaultFillViewModel(filler: filler)
        let run = Task { await fill.begin() }
        for _ in 0..<200 where !filler.isHeld {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(filler.isHeld)
        #expect(fill.phase == .draining(bodies(3, of: 9)))
        #expect(fill.strip == bodies(3, of: 9))
        #expect(!fill.isPending)
        filler.finish()
        await run.value
        #expect(fill.strip == nil)
    }

    @Test("the strip shows records before their total is known, and hides at done")
    func theStripFollowsThePhase() async throws {
        let filler = HeldFiller(
            store: VaultStore(), fills: 0,
            ticks: [SyncProgress(phase: .records, completed: 3_200, total: nil)]
        )
        let fill = VaultFillViewModel(filler: filler)
        let run = Task { await fill.begin() }
        for _ in 0..<200 where !filler.isHeld {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(fill.strip == SyncProgress(phase: .records, completed: 3_200, total: nil))
        filler.finish()
        await run.value
    }
}

/// A vault whose first drain round ticks, then holds until ``finish()``.
/// With `firstSyncTicks` it first runs a first sync that sends them; without,
/// the gate says the vault is already synced. Rounds after the first owe
/// nothing.
final class HeldDrainFiller: VaultFilling, @unchecked Sendable {
    private let release = Mutex<CheckedContinuation<Void, Never>?>(nil)
    private let count = Mutex(0)
    private let firstSyncTicks: [SyncProgress]
    private let firstRoundTick: SyncProgress?
    private let firstRound: BodyDrainSummary

    init(
        firstSyncTicks: [SyncProgress] = [],
        firstRoundTick: SyncProgress? = SyncProgress(phase: .bodies, completed: 3, total: 9),
        firstRound: BodyDrainSummary = .round(9, remaining: 0)
    ) {
        self.firstSyncTicks = firstSyncTicks
        self.firstRoundTick = firstRoundTick
        self.firstRound = firstRound
    }

    var isHeld: Bool { release.withLock { $0 != nil } }
    var rounds: Int { count.withLock { $0 } }

    func finish() {
        release.withLock { held in
            held?.resume()
            held = nil
        }
    }

    func isFirstSyncComplete() async throws -> Bool { firstSyncTicks.isEmpty }

    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        for tick in firstSyncTicks {
            await MainActor.run { progress(tick) }
        }
        return .none
    }

    func drainBodies(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> BodyDrainSummary {
        let round = count.withLock { count in
            count += 1
            return count
        }
        guard round == 1 else { return .round(0, remaining: 0) }
        if let tick = firstRoundTick {
            await MainActor.run { progress(tick) }
        }
        await withCheckedContinuation { continuation in
            release.withLock { $0 = continuation }
        }
        return firstRound
    }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}
