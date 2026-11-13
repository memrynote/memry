import Foundation
import MemryCore
import Observation
import SwiftUI
import Testing
import UIKit

@testable import Memry

// The vault scope keeps the search index up to date (REVIEW-4419 #6): after
// every sync pass and on every local write's sync request. These host the
// real `VaultTasksScope` over a scratch vault and its real index, and watch
// the index owner it hands down.

@MainActor
@Suite("Vault search wiring", .serialized)
struct VaultSearchWiringTests {
    /// What the scope hands its content.
    @Observable
    final class Probe {
        var index: VaultSearchIndex?
        var request: (@MainActor () -> Void)?
        var store: TasksStore?
        /// Shows the portal, once the test has its baseline.
        var portal = false
    }

    private struct ProbeView: View {
        let probe: Probe
        let store: TasksStore?
        let browse: VaultBrowseViewModel?
        @Environment(\.vaultSearchIndex) private var index
        @Environment(\.requestVaultSync) private var request

        var body: some View {
            VStack {
                if probe.portal {
                    PortalBlockView(text: #"{"v":1,"note":"n1"}"#).environment(\.vaultBrowse, browse)
                }
                probeTask
            }
        }

        private var probeTask: some View {
            Color.clear.task(id: Key(index: index.map(ObjectIdentifier.init), store: store.map(ObjectIdentifier.init))) {
                probe.index = index
                probe.request = request
                probe.store = store
            }
        }

        private struct Key: Equatable {
            let index: ObjectIdentifier?
            let store: ObjectIdentifier?
        }
    }

    /// A filler whose passes reach no server and land nothing.
    private final class QuietFiller: VaultFilling, @unchecked Sendable {
        func isFirstSyncComplete() async throws -> Bool { true }
        func firstSync(
            progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
        ) async throws -> FirstSyncSummary { .none }
        func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
            BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
        }
    }

    /// A filler whose every body pull lands an update.
    private final class LandingFiller: VaultFilling, @unchecked Sendable {
        func isFirstSyncComplete() async throws -> Bool { true }
        func firstSync(
            progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
        ) async throws -> FirstSyncSummary { .none }
        func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
            BodyFetchSummary(updates: 1, baselines: 0, stopped: false)
        }
    }

    private func host(filler: (any VaultFilling)?, portalFiller: (any VaultFilling)? = nil) throws -> (UIWindow, Probe) {
        let vault = try TasksTestVault()
        let probe = Probe()
        let browse = VaultBrowseViewModel(
            reader: CoreNotesReader(vault: vault.vault, executor: .shared), filler: portalFiller
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        window.rootViewController = UIHostingController(
            rootView: VaultTasksScope(vault: vault.vault, secureStore: TaskTestKeychain(), filler: filler) { store, _ in
                ProbeView(probe: probe, store: store, browse: browse)
            }
        )
        window.makeKeyAndVisible()
        return (window, probe)
    }

    /// Waits, a bounded number of turns, until `done` holds.
    private func until(_ done: () -> Bool) async throws {
        for _ in 0 ..< 100 where !done() {
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    /// The scope's own first reindex, once the vault opened and its first
    /// pass ended. Answers the count after it.
    private func opened(_ probe: Probe, passes: Int) async throws -> Int {
        try await until { probe.store != nil && (probe.store?.syncPasses ?? 0) >= passes && (probe.index?.completed ?? 0) >= 1 }
        let index = try #require(probe.index)
        await index.settle()
        return index.completed
    }

    @Test("a finished sync pass brings the index up to date")
    func aSyncPassSchedulesTheIndex() async throws {
        let (window, probe) = try host(filler: QuietFiller())
        defer { window.isHidden = true }
        let before = try await opened(probe, passes: 1)
        let store = try #require(probe.store)

        await store.sync()
        try await until { (probe.index?.completed ?? 0) > before }

        #expect((probe.index?.completed ?? 0) > before, "the pass never reached the index")
    }

    @Test("a local write's sync request brings the index up to date")
    func aSyncRequestSchedulesTheIndex() async throws {
        // No filler: the request starts no pass, so only its own scheduling
        // can move the index.
        let (window, probe) = try host(filler: nil)
        defer { window.isHidden = true }
        let before = try await opened(probe, passes: 0)
        let request = try #require(probe.request)

        request()
        try await until { (probe.index?.completed ?? 0) > before }

        #expect((probe.index?.completed ?? 0) > before, "the request never reached the index")
    }

    /// VERIFY-4419 #1: a pull outside a note page (here a portal onto another
    /// note) lands content outside a sync pass, and the scope still brings
    /// the index up to date.
    @Test("a portal's body pull brings the index up to date")
    func aPortalPullSchedulesTheIndex() async throws {
        let (window, probe) = try host(filler: nil, portalFiller: LandingFiller())
        defer { window.isHidden = true }
        let before = try await opened(probe, passes: 0)

        probe.portal = true
        try await until { (probe.index?.completed ?? 0) > before }

        #expect((probe.index?.completed ?? 0) > before, "the portal's pull never reached the index")
    }
}
