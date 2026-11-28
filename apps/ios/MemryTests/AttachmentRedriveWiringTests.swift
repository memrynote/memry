import Foundation
import MemryCore
import os
import Synchronization
import Testing

@testable import Memry

// #3261: the core's attachment re-driver must run after every sync pass, with
// the shell's current path, and never while offline.

private final class RecordingRedrives: VaultFilling, @unchecked Sendable {
    private let calls = Mutex<[Reachable]>([])
    private let inboxCalls = Mutex(0)
    var reachables: [Reachable] { calls.withLock { $0 } }
    var inboxPasses: Int { inboxCalls.withLock { $0 } }

    func syncInboxAttachments(reachable: Reachable) async throws -> InboxAttachmentSyncSummary {
        inboxCalls.withLock { $0 += 1 }
        return InboxAttachmentSyncSummary(uploaded: 0, downloaded: 0, deferred: 0, failed: 0, released: 0)
    }

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

/// A redrive that answers `summary`, or throws `error` when set.
private final class ScriptedRedrive: VaultFilling, @unchecked Sendable {
    let summary: AttachmentRedriveSummary
    let error: SyncError?

    init(
        summary: AttachmentRedriveSummary = .init(downloaded: 0, deferred: 0, failed: 0, remaining: 0),
        error: SyncError? = nil
    ) {
        self.summary = summary
        self.error = error
    }

    func syncInboxAttachments(reachable: Reachable) async throws -> InboxAttachmentSyncSummary {
        if let error { throw error }
        return InboxAttachmentSyncSummary(uploaded: 0, downloaded: 0, deferred: 0, failed: 0, released: 0)
    }

    func redriveAttachments(reachable: Reachable) async throws -> AttachmentRedriveSummary {
        if let error { throw error }
        return summary
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

/// The lines a redrive logged, by level.
private final class LoggedLines: @unchecked Sendable {
    private let lines = Mutex<[(OSLogType, String)]>([])
    var errors: [String] { lines.withLock { $0.filter { $0.0 == .error }.map { $0.1 } } }
    var log: Log { Log(capturing: { level, line in self.lines.withLock { $0.append((level, line)) } }) }
}

@MainActor
@Suite("Attachment redrive wiring")
struct AttachmentRedriveWiringTests {
    @Test func a_sync_pass_redrives_attachments() async throws {
        let filler = RecordingRedrives()
        let vault = try TasksTestVault(filler: filler)
        await vault.store.sync()
        // The redrive runs after the pass, outside it (#4155). Counted by its
        // Inbox pass, which runs whatever this device's Download attachments
        // setting (#5644); the setting's note redrive is pinned below.
        let deadline = Date().addingTimeInterval(3)
        while filler.inboxPasses == 0, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        #expect(filler.inboxPasses == 1)
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
    /// every unmetered-only row on `.cellular` and every row is one, so On
    /// Wi-Fi downloads nothing on cellular, Always downloads on cellular, and
    /// Never asks for nothing.
    @Test(arguments: [
        (AttachmentDownload.never, Reachable.wifi, [Reachable]()),
        (.never, .cellular, []),
        (.wifi, .wifi, [.wifi]),
        (.wifi, .cellular, [.cellular]),
        (.always, .wifi, [.wifi]),
        (.always, .cellular, [.wifi])
    ])
    func the_setting_picks_the_path_a_background_download_is_judged_on(
        setting: AttachmentDownload,
        observed: Reachable,
        judged: [Reachable]
    ) async {
        let filler = RecordingRedrives()
        await AttachmentRedriver(filler: filler, reachability: { observed }, setting: { setting }).redrive()
        #expect(filler.reachables == judged)
    }

    /// Build 1017 logged only a count, so telemetry could not say why the same
    /// attachments kept failing. Each reason now reaches it as its own code.
    @Test func each_failure_reason_is_logged_with_its_code() async {
        let lines = LoggedLines()
        let summary = AttachmentRedriveSummary(
            downloaded: 0, deferred: 0, failed: 3, remaining: 0,
            failures: [
                AttachmentRedriveFailure(reason: .notFound, count: 2),
                AttachmentRedriveFailure(reason: .unverified, count: 1)
            ]
        )
        await AttachmentRedriver(
            filler: ScriptedRedrive(summary: summary), reachability: { .wifi }, setting: { .wifi }, log: lines.log
        ).redrive()
        #expect(lines.errors == [
            "attachment redrive failed [code=attachmentRedrive.notFound]",
            "attachment redrive failed [code=attachmentRedrive.unverified]"
        ])
    }

    /// A device with no account key yet cannot download anything, and the
    /// pass after its unlock redrives again: waiting is not an error.
    @Test func a_locked_device_logs_no_error() async {
        let lines = LoggedLines()
        await AttachmentRedriver(
            filler: ScriptedRedrive(error: .Locked), reachability: { .wifi }, setting: { .wifi }, log: lines.log
        ).redrive()
        #expect(lines.errors.isEmpty)
    }
}
