import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #3261: the core's attachment re-driver must run after every sync pass, with
// the shell's current path, and never while offline.

private final class RecordingRedrives: VaultFilling, @unchecked Sendable {
    private let calls = Mutex<[Reachable]>([])
    var reachables: [Reachable] { calls.withLock { $0 } }

    func redriveAttachments(reachable: Reachable) async throws -> AttachmentRedriveSummary {
        calls.withLock { $0.append(reachable) }
        return AttachmentRedriveSummary(downloaded: 0, deferred: 0, failed: 0, remaining: 0)
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        throw SyncError.Locked
    }
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
        throw SyncError.Locked
    }
}

@MainActor
@Suite("Attachment redrive wiring")
struct AttachmentRedriveWiringTests {
    @Test func a_sync_pass_redrives_attachments() async throws {
        let filler = RecordingRedrives()
        let vault = try TasksTestVault(filler: filler)
        await vault.store.sync()
        #expect(filler.reachables.count == 1)
    }

    @Test func the_redrive_carries_the_current_path_so_the_metered_policy_applies() async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { .cellular }).redrive()
        await AttachmentRedriver(filler: filler, reachability: { .wifi }).redrive()
        #expect(filler.reachables == [.cellular, .wifi])
    }

    @Test func offline_does_not_redrive() async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { .offline }).redrive()
        #expect(filler.reachables.isEmpty)
    }
}
