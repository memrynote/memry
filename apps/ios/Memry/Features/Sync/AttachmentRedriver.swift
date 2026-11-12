import Foundation
import MemryCore

/// Retries missing attachment downloads (#3261) and syncs the Inbox's files
/// (#4157) after each sync pass and when the network path changes. The core
/// owns which attachments are missing or pending and whether this path may
/// fetch them (FR-045); this only passes the current path, keeps calls from
/// overlapping, and relays what changed.
@MainActor
final class AttachmentRedriver {
    /// Posted when Inbox files were written to disk, for the Inbox to re-read.
    static let inboxFilesDownloaded = Notification.Name("AttachmentRedriver.inboxFilesDownloaded")

    /// Asks the vault scheduler for one more sync pass. An upload set the
    /// capture's `attachmentId` locally, and only a pass sends it to other
    /// devices. Only an upload asks, so the pass it causes uploads nothing and
    /// the chain ends there.
    var requestSync: (@MainActor () -> Void)?

    private let filler: any VaultFilling
    private let reachability: @Sendable () -> Reachable
    private let center: NotificationCenter
    private var running = false

    init(
        filler: any VaultFilling,
        reachability: @escaping @Sendable () -> Reachable = { PathReachability.forAttachments.current() },
        center: NotificationCenter = .default
    ) {
        self.filler = filler
        self.reachability = reachability
        self.center = center
    }

    func redrive() async {
        let reachable = reachability()
        guard reachable != .offline, !running else { return }
        running = true
        defer { running = false }
        await redriveNoteAttachments(reachable)
        await syncInboxFiles(reachable)
    }

    private func redriveNoteAttachments(_ reachable: Reachable) async {
        do {
            let summary = try await filler.redriveAttachments(reachable: reachable)
            if summary.downloaded > 0 {
                Log.sync.info("attachment redrive downloaded", .count(Int(summary.downloaded)))
            }
            if summary.failed > 0 {
                Log.sync.error("attachment redrive failed", .count(Int(summary.failed)))
            }
        } catch {
            Log.sync.error("attachment redrive refused", .code(ErrorMapping.userFacing(error).code))
        }
    }

    private func syncInboxFiles(_ reachable: Reachable) async {
        do {
            let summary = try await filler.syncInboxAttachments(reachable: reachable)
            if summary.uploaded > 0 {
                Log.sync.info("inbox files uploaded", .count(Int(summary.uploaded)))
                requestSync?()
            }
            if summary.downloaded > 0 {
                Log.sync.info("inbox files downloaded", .count(Int(summary.downloaded)))
                center.post(name: Self.inboxFilesDownloaded, object: nil)
            }
            if summary.failed > 0 {
                Log.sync.error("inbox file sync failed", .count(Int(summary.failed)))
            }
        } catch {
            Log.sync.error("inbox file sync refused", .code(ErrorMapping.userFacing(error).code))
        }
    }
}
