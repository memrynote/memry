import MemryCore
import SwiftUI

// #5532: an attachment kept on this device (#5510) that a later sync pass
// could not upload because the server refused it. The core tells each refusal
// once, and tells again when that upload lands, so this holds what the user
// has not dismissed yet and drops what landed in the meantime.

/// One refused upload, as the alert shows it.
struct AttachmentRefusalAlert: Equatable, Identifiable {
    let attachmentId: String
    let noteId: String
    let noteTitle: String
    let refusal: AttachmentRefusal

    var id: String { attachmentId }
}

/// The refusals waiting for the user, oldest first. One per attachment.
@MainActor
@Observable
final class AttachmentRefusals {
    static let shared = AttachmentRefusals()
    private(set) var pending: [AttachmentRefusalAlert] = []

    /// The alert on screen.
    var shown: AttachmentRefusalAlert? { pending.first }

    /// Takes a sync pass's news: a refusal waits for the user, and an upload
    /// that landed takes its refusal back.
    func absorb(_ news: [QueuedAttachmentNews]) {
        for item in news {
            switch item {
            case let .refused(attachmentId, noteId, noteTitle, refusal, _):
                let alert = AttachmentRefusalAlert(
                    attachmentId: attachmentId, noteId: noteId, noteTitle: noteTitle, refusal: refusal
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

    func dismiss() {
        if !pending.isEmpty { pending.removeFirst() }
    }

    /// The vault closed: its notes cannot be opened from another one.
    func clear() { pending = [] }
}

enum AttachmentRefusalCopy {
    static func title(_ alert: AttachmentRefusalAlert) -> String {
        let note = alert.noteTitle.isEmpty ? "Untitled" : alert.noteTitle
        return "A file in \u{201C}\(note)\u{201D} could not sync"
    }

    static func message(_ refusal: AttachmentRefusal) -> String {
        let device = ThisDevice.noun
        return switch refusal {
        case .storageFull:
            "Your storage is full. The file stays on this \(device) and syncs once you free up space."
        case .notAllowed:
            "Your account cannot upload this file. It stays on this \(device) until you remove it from the note."
        case .rejected:
            "The server refused this file. It stays on this \(device) until you remove it from the note."
        }
    }

    static let openNote = "Open Note"
    static let freeUpSpace = "Free Up Space"
    static let notNow = "Not Now"
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

    func body(content: Content) -> some View {
        let shown = refusals.shown
        content
            .alert(
                shown.map(AttachmentRefusalCopy.title) ?? "",
                isPresented: Binding(get: { shown != nil }, set: { if !$0 { refusals.dismiss() } }),
                presenting: shown
            ) { alert in
                if alert.refusal == .storageFull {
                    Button(AttachmentRefusalCopy.freeUpSpace) {
                        refusals.dismiss()
                        openStorage()
                    }
                }
                Button(AttachmentRefusalCopy.openNote) {
                    refusals.dismiss()
                    openNote(alert.noteId)
                }
                Button(AttachmentRefusalCopy.notNow, role: .cancel) { refusals.dismiss() }
            } message: { alert in
                Text(AttachmentRefusalCopy.message(alert.refusal))
            }
            .onDisappear { refusals.clear() }
    }
}
