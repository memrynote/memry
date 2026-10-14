import Foundation
import MemryCore

/// Retries missing attachment downloads (#3261) after each sync pass and when
/// the network path changes. The core owns which attachments are missing and
/// whether this path may fetch them (FR-045); this only passes the current
/// path and keeps calls from overlapping.
@MainActor
final class AttachmentRedriver {
    private let filler: any VaultFilling
    private let reachability: @Sendable () -> Reachable
    private var running = false

    init(
        filler: any VaultFilling,
        reachability: @escaping @Sendable () -> Reachable = { PathReachability.forAttachments.current() }
    ) {
        self.filler = filler
        self.reachability = reachability
    }

    func redrive() async {
        let reachable = reachability()
        guard reachable != .offline, !running else { return }
        running = true
        defer { running = false }
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
}
