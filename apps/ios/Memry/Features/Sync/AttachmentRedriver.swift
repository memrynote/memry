import Foundation
import MemryCore

/// Retries missing attachment downloads (#3261) and syncs the Inbox's files
/// (#4157) after each sync pass and when the network path changes. The core
/// owns which attachments are missing or pending and whether a path may fetch
/// them (FR-045); this passes the current path, keeps calls from overlapping,
/// and relays what changed. Note attachments follow this device's Download
/// attachments setting (#5644, `AttachmentDownloadPath.swift`). Inbox files do
/// not, as on desktop (`apps/desktop/src/main/inbox/attachment-sync.ts`).
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
    private let setting: @MainActor () -> AttachmentDownload
    private let center: NotificationCenter
    private let log: Log
    private var running = false

    init(
        filler: any VaultFilling,
        reachability: @escaping @Sendable () -> Reachable = { PathReachability.forAttachments.current() },
        setting: @escaping @MainActor () -> AttachmentDownload = { LocalSettings.shared.attachmentDownload },
        center: NotificationCenter = .default,
        log: Log = .sync
    ) {
        self.filler = filler
        self.reachability = reachability
        self.setting = setting
        self.center = center
        self.log = log
    }

    func redrive() async {
        let observed = reachability()
        guard observed != .offline, !running else { return }
        running = true
        defer { running = false }
        let notes = setting().backgroundPath(on: observed)
        if notes != .offline { await redriveNoteAttachments(notes) }
        await syncInboxFiles(observed)
    }

    /// One error line per reason a download failed, so telemetry says why.
    /// The core schedules each failed attachment's next attempt, so a line
    /// repeats only when an attempt was due.
    private func redriveNoteAttachments(_ reachable: Reachable) async {
        do {
            let summary = try await filler.redriveAttachments(reachable: reachable)
            if summary.downloaded > 0 {
                log.info("attachment redrive downloaded", .count(Int(summary.downloaded)))
            }
            for failure in summary.failures {
                log.error("attachment redrive failed", .code(Self.code(failure.reason)))
            }
        } catch SyncError.Locked {
            // No account key on this device yet. Nothing can download until
            // it unlocks, and the sync pass after the unlock redrives again.
            log.info("attachment redrive waits for unlock")
        } catch {
            log.error("attachment redrive refused", .code(ErrorMapping.userFacing(error).code))
        }
    }

    private static func code(_ reason: AttachmentFailureReason) -> ErrorCode {
        switch reason {
        case .notFound: "attachmentRedrive.notFound"
        case .unverified: "attachmentRedrive.unverified"
        case .corrupt: "attachmentRedrive.corrupt"
        case .rateLimited: "attachmentRedrive.rateLimited"
        case .server: "attachmentRedrive.server"
        case .refused: "attachmentRedrive.refused"
        case .network: "attachmentRedrive.network"
        case .keyStore: "attachmentRedrive.keyStore"
        case .storage: "attachmentRedrive.storage"
        case .other: "attachmentRedrive.other"
        }
    }

    private func syncInboxFiles(_ reachable: Reachable) async {
        do {
            let summary = try await filler.syncInboxAttachments(reachable: reachable)
            if summary.uploaded > 0 {
                log.info("inbox files uploaded", .count(Int(summary.uploaded)))
                requestSync?()
            }
            if summary.downloaded > 0 {
                log.info("inbox files downloaded", .count(Int(summary.downloaded)))
                center.post(name: Self.inboxFilesDownloaded, object: nil)
            }
            if summary.failed > 0 {
                log.error("inbox file sync failed", .count(Int(summary.failed)))
            }
        } catch SyncError.Locked {
            log.info("inbox file sync waits for unlock")
        } catch {
            log.error("inbox file sync refused", .code(ErrorMapping.userFacing(error).code))
        }
    }
}
