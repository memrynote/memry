import MemryCore
import SwiftUI
import UniformTypeIdentifiers

// #4357. Notes and drag and drop on iPad. A note row drags out as the plain
// text "Share a copy" hands over, plus the note's `memry://note/<id>` link
// (`NoteRelationValue.uri`, `relation-uri.ts`), for other apps. The editor
// reads only a private type that names the note and its vault, so a Safari
// link is not taken for a note. A drop on a folder row waits on #5313: the
// list is one `List`, which keeps a drag from its own rows away from them.

extension UTType {
    /// A note dragged out of a Memry row: its `NoteDragPayload`. Exported in
    /// `Info.plist` and registered for this process only.
    static let memryNote = UTType(exportedAs: "com.memrynote.app.note")
}

/// What a note drag tells Memry's own drop targets.
struct NoteDragPayload: Codable, Hashable, Sendable {
    let noteId: String
    let vaultId: String
}

/// A note drag: the source side, and the payloads a drop reads.
enum NoteDrag {
    /// The private payload first, then the plain text for apps that take
    /// text, then the link. The text is read only when a receiver asks for
    /// it: the editor loads the payload alone, and no body is fetched.
    @MainActor
    static func provider(
        for note: NoteSummary,
        vaultId: String,
        text: @escaping @MainActor () async -> String?
    ) -> NSItemProvider {
        let payload = NoteDragPayload(noteId: note.id, vaultId: vaultId)
        let provider = NSItemProvider()
        provider.suggestedName = note.title
        if let data = try? JSONEncoder().encode(payload) {
            provider.registerDataRepresentation(for: .memryNote, visibility: .ownProcess) { completion in
                completion(data, nil)
                return nil
            }
        }
        provider.registerDataRepresentation(for: .utf8PlainText, visibility: .all) { completion in
            // The provider may be answered from any thread; its handler type
            // predates `@Sendable`.
            nonisolated(unsafe) let completion = completion
            Task { @MainActor in
                if let text = await text() {
                    completion(Data(text.utf8), nil)
                } else {
                    completion(nil, CocoaError(.fileReadUnknown))
                }
            }
            return nil
        }
        if let link = URL(string: NoteRelationValue.uri(noteId: note.id)) {
            provider.registerObject(link as NSURL, visibility: .all)
        }
        return provider
    }

    /// The note payloads the dropped providers carry. Anything else, a
    /// Safari link among them, carries none.
    @MainActor
    static func payloads(from providers: [NSItemProvider]) async -> [NoteDragPayload] {
        var payloads: [NoteDragPayload] = []
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.memryNote.identifier) {
            let data: Data? = await withCheckedContinuation { continuation in
                _ = provider.loadDataRepresentation(for: .memryNote) { data, _ in
                    continuation.resume(returning: data)
                }
            }
            if let payload = data.flatMap({ try? JSONDecoder().decode(NoteDragPayload.self, from: $0) }) {
                payloads.append(payload)
            }
        }
        return payloads
    }
}

/// A note row that drags. Inside the iPad split view only: the stack, every
/// iPhone among it, keeps the row's long press as the menu alone. Not a size
/// class check: the list is the split view's sidebar column, which reports a
/// compact width.
struct NoteDragSource: ViewModifier {
    let note: NoteSummary
    let model: VaultBrowseViewModel

    @Environment(NotesSplitRouter.self) private var split: NotesSplitRouter?
    @Environment(\.handoffVaultId) private var vaultId

    func body(content: Content) -> some View {
        if let vaultId, split != nil {
            content.onDrag {
                NoteDrag.provider(for: note, vaultId: vaultId) { [model, id = note.id] in
                    await model.exportNote(id: id)?.contents
                }
            }
        } else {
            content
        }
    }
}
