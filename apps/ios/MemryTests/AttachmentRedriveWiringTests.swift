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
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
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
        // The redrive runs after the pass, outside it (#4155).
        let deadline = Date().addingTimeInterval(3)
        while filler.reachables.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(filler.reachables.count == 1)
    }

    @Test func the_redrive_carries_the_current_path_so_the_metered_policy_applies() async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { .cellular }, setting: { .wifi }).redrive()
        await AttachmentRedriver(filler: filler, reachability: { .wifi }, setting: { .wifi }).redrive()
        #expect(filler.reachables == [.cellular, .wifi])
    }

    @Test(arguments: AttachmentDownload.allCases)
    func offline_does_not_redrive(setting: AttachmentDownload) async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { .offline }, setting: { setting }).redrive()
        #expect(filler.reachables.isEmpty)
    }

    /// #5644: the Download attachments setting picks the path the core's
    /// metered policy judges a background download against. The core defers
    /// every unmetered-only row on `.cellular` and every row is one, so Never
    /// downloads nothing on Wi-Fi and Always downloads on cellular.
    @Test(arguments: [
        (AttachmentDownload.never, Reachable.wifi, Reachable.cellular),
        (.never, .cellular, .cellular),
        (.wifi, .wifi, .wifi),
        (.wifi, .cellular, .cellular),
        (.always, .wifi, .wifi),
        (.always, .cellular, .wifi)
    ])
    func the_setting_picks_the_path_a_background_download_is_judged_on(
        setting: AttachmentDownload,
        observed: Reachable,
        judged: Reachable
    ) async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { observed }, setting: { setting }).redrive()
        #expect(filler.reachables == [judged])
    }
}
