import MemryCore
import SwiftUI

// #5532: an attachment kept on this device (#5510) that a later sync pass
// could not upload because the server refused it. The core tells each refusal
// once, and tells again when that upload lands, so this holds what the user
// has not dismissed yet and drops what landed in the meantime.

/// One refused upload, as the alert shows it.
struct AttachmentRefusalAlert: Equatable, Identifiable {
    /// The vault whose sync pass told it: only that vault can open the note.
    let vaultId: String
    let attachmentId: String
    let noteId: String
    let noteTitle: String
    let refusal: AttachmentRefusal
    /// The HTTP status, 0 for bytes this device could not frame.
    let status: UInt16

    var id: String { attachmentId }

    /// Only a full quota clears by freeing space.
    var offersFreeUpSpace: Bool { refusal == .storageFull }
}

/// The refusals waiting for the user, oldest first. One per attachment.
@MainActor
@Observable
final class AttachmentRefusals {
    static let shared = AttachmentRefusals()
    private(set) var pending: [AttachmentRefusalAlert] = []

    /// The alert on screen in the open vault.
    func shown(in vaultId: String?) -> AttachmentRefusalAlert? {
        pending.first { $0.vaultId == vaultId }
    }

    /// Takes a sync pass's news for `vaultId`: a refusal waits for the user,
    /// and an upload that landed takes its refusal back.
    func absorb(_ news: [QueuedAttachmentNews], vaultId: String) {
        for item in news {
            switch item {
            case let .refused(attachmentId, noteId, noteTitle, refusal, status):
                let alert = AttachmentRefusalAlert(
                    vaultId: vaultId, attachmentId: attachmentId, noteId: noteId, noteTitle: noteTitle,
                    refusal: refusal, status: status
                )
                if let index = pending.firstIndex(where: { $0.id == attachmentId }) {
                    pending[index] = alert
                } else {
                    pending.append(alert)
                }
            case let .uploaded(attachmentId, _):
                pending.removeAll { $0.id == attachmentId }
            }
        }
    }

    /// Idempotent: one tap dismisses through both the button and the
    /// alert's `isPresented` setter.
    func dismiss(_ attachmentId: String) {
        pending.removeAll { $0.id == attachmentId }
    }
}

enum AttachmentRefusalCopy {
    static func title(_ alert: AttachmentRefusalAlert) -> String {
        let note = alert.noteTitle.isEmpty ? "Untitled" : alert.noteTitle
        return "A file in \u{201C}\(note)\u{201D} could not sync"
    }

    static func message(_ alert: AttachmentRefusalAlert) -> String {
        let device = ThisDevice.noun
        let stays = "It stays on this \(device) until you remove it from the note."
        return switch (alert.refusal, alert.status) {
        case (.storageFull, _):
            "Your storage is full. The file stays on this \(device) and syncs once you free up space."
        case (.tooLarge, _):
            "This file is too large to sync. \(stays)"
        case (.notAllowed, _):
            "Your account cannot upload this file. \(stays)"
        case (.rejected, 402):
            "Your sync plan is not active. The file stays on this \(device) and syncs once you renew it."
        case (.rejected, 0):
            "This \(device) could not prepare the file for sync. \(stays)"
        case (.rejected, _):
            "The server refused this file. \(stays)"
        }
    }

    static let openNote = "Open note"
    static let freeUpSpace = "Free up space"
    static let dismiss = "OK"
}

extension View {
    /// Shows each refused attachment upload once, with the way out: open the
    /// note to remove the file, or, when storage is full, free up space.
    func attachmentRefusalAlert(
        openNote: @escaping (String) -> Void,
        openStorage: @escaping () -> Void
    ) -> some View {
        modifier(AttachmentRefusalHost(openNote: openNote, openStorage: openStorage))
    }
}

private struct AttachmentRefusalHost: ViewModifier {
    let openNote: (String) -> Void
    let openStorage: () -> Void
    @State private var refusals = AttachmentRefusals.shared
    @Environment(\.handoffVaultId) private var vaultId

    func body(content: Content) -> some View {
        let shown = refusals.shown(in: vaultId)
        content
            .alert(
                shown.map(AttachmentRefusalCopy.title) ?? "",
                isPresented: Binding(
                    get: { shown != nil },
                    set: { if !$0, let shown { refusals.dismiss(shown.id) } }
                ),
                presenting: shown
            ) { alert in
                if alert.offersFreeUpSpace {
                    Button(AttachmentRefusalCopy.freeUpSpace) {
                        refusals.dismiss(alert.id)
                        openStorage()
                    }
                }
                Button(AttachmentRefusalCopy.openNote) {
                    refusals.dismiss(alert.id)
                    openNote(alert.noteId)
                }
                Button(AttachmentRefusalCopy.dismiss, role: .cancel) { refusals.dismiss(alert.id) }
            } message: { alert in
                Text(AttachmentRefusalCopy.message(alert))
            }
    }
}
