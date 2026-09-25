import Foundation
import MemryCore

// IB22 / D7. The app's half of the Share extension: captures what the
// extension left in the app group, through the composer's own path
// (`quick-capture`, desktop's value for its floating capture window), and
// keeps the digests the extension's duplicate notice reads current.

extension InboxStore {
    /// Captures every waiting drop into this vault, oldest first. A drop is
    /// removed once the capture ran, whatever it answered: a duplicate or a
    /// refused file would answer the same way on every retry.
    func ingestShared() async {
        guard let root = shareRoot else { return }
        let pending = ShareQueue.pending(root: root)
        guard !pending.isEmpty else { return }
        var saved = 0
        var duplicates = 0
        for (drop, payload) in pending {
            switch await capture(drop, payload: payload) {
            case .captured: saved += 1
            case .duplicate: duplicates += 1
            case .failed: Log.core.error("a shared capture could not be saved")
            }
            ShareQueue.remove(drop.id, root: root)
        }
        if saved > 0 {
            showToast(InboxCopy.savedFromShare(saved))
        } else if duplicates > 0 {
            showToast(InboxCopy.sharedAlreadyCaptured)
        }
    }

    /// The live link captures' digests, for the extension's duplicate notice.
    func publishKnownLinks() {
        guard let root = shareRoot else { return }
        ShareQueue.publishKnownLinks(items.compactMap(\.sourceUrl), root: root)
    }

    private func capture(_ drop: ShareDrop, payload: URL?) async -> InboxCaptureResult {
        switch drop.kind {
        case .link, .text:
            return await capture(drop.text ?? "", force: drop.force, source: "quick-capture")
        case .file:
            guard let payload, let data = try? Data(contentsOf: payload) else { return .failed }
            return await captureFile(
                data: data,
                filename: drop.filename ?? "Shared file",
                mimeType: drop.mimeType ?? "application/octet-stream",
                source: "quick-capture"
            )
        }
    }
}
