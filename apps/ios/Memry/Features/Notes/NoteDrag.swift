import MemryCore
import SwiftUI
import UniformTypeIdentifiers

// #4357. Notes and drag and drop on iPad. A note row drags out as the plain
// text "Share a copy" hands over, plus the note's `memry://note/<id>` link
// (`NoteRelationValue.uri`, `relation-uri.ts`), for other apps. Memry's own
// folder targets read only a private type that names the note and its vault,
// so a Safari link or another vault's note is refused. A folder in the Notes
// sidebar moves each dropped note with the "Move to folder" operation
// (`VaultBrowseViewModel.moveNote`), so a drop and the menu write the same.

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

/// The drag source side.
enum NoteDrag {
    private final class Entry {
        let payload: NoteDragPayload
        init(_ payload: NoteDragPayload) { self.payload = payload }
    }

    /// The notes this app is dragging, by the provider that carries each. A
    /// hovering drop cannot load a provider's data yet, so the folder targets
    /// read these to refuse a drop that would move nothing. Providers are
    /// held weakly: an entry goes when the system lets go of its drag, and a
    /// drop clears them all.
    @MainActor private static let live = NSMapTable<NSItemProvider, Entry>.weakToStrongObjects()

    @MainActor static var dragged: [NoteDragPayload] {
        live.keyEnumerator().allObjects.compactMap { key in
            (key as? NSItemProvider).flatMap { live.object(forKey: $0)?.payload }
        }
    }

    @MainActor static func dropped() { live.removeAllObjects() }

    /// The private payload first, then the plain text for apps that take
    /// text, then the link. The text is read only when a receiver asks for
    /// it: a drop on a folder loads the payload alone, and no body is fetched.
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
            live.setObject(Entry(payload), forKey: provider)
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
}

/// A note row that drags. Regular width only: compact width, every iPhone
/// among it, keeps the row's long press as the menu alone.
struct NoteDragSource: ViewModifier {
    let note: NoteSummary
    let model: VaultBrowseViewModel

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.handoffVaultId) private var vaultId

    func body(content: Content) -> some View {
        if let vaultId, LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass) == .regular {
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

/// The drop target side's decisions, kept pure for tests.
@MainActor
enum NoteFolderDrop {
    /// The only type a folder takes.
    static let types: [UTType] = [.memryNote]

    /// Whether a note in `current` moves when dropped on `folder` (`nil` is
    /// the vault root). Not onto the folder it is already in, which the
    /// "Move to folder" menu leaves out too.
    static func moves(from current: String?, to folder: String?) -> Bool {
        (current ?? "") != (folder ?? "")
    }

    /// The dragged notes a drop on `folder` moves: those of `vaultId` that
    /// its outline holds, outside `folder`.
    static func moving(
        _ payloads: [NoteDragPayload],
        vaultId: String,
        outline: VaultOutline?,
        to folder: String?
    ) -> [NoteSummary] {
        guard let outline else { return [] }
        let ids = Set(payloads.filter { $0.vaultId == vaultId }.map(\.noteId))
        return outline.allNotes.filter { ids.contains($0.id) && moves(from: $0.folderPath, to: folder) }
    }

    /// The note payloads the dropped providers carry. Anything else, a
    /// Safari link among them, carries none.
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

    /// Moves every note the providers carry that a drop on `folder` moves.
    /// Answers how many it moved.
    @discardableResult
    static func drop(
        _ providers: [NSItemProvider],
        vaultId: String,
        on folder: String?,
        model: VaultBrowseViewModel
    ) async -> Int {
        let notes = moving(await payloads(from: providers), vaultId: vaultId, outline: model.outline, to: folder)
        if notes.isEmpty { Log.storage.error("a note drop carried no note to move", .code("notes.drop")) }
        for note in notes {
            await model.moveNote(id: note.id, to: folder)
        }
        return notes.count
    }
}

/// A Notes sidebar row that takes dropped notes: the tint marks it while a
/// note that would move hovers, and the drop moves every such note there.
struct NoteFolderDropTarget: ViewModifier {
    /// `nil` is the vault root.
    let folder: String?
    let model: VaultBrowseViewModel

    @Environment(\.handoffVaultId) private var vaultId
    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .background {
                if isTargeted {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small)
                        .strokeBorder(Tokens.Tint.base.color, lineWidth: 2)
                }
            }
            .onDrop(
                of: NoteFolderDrop.types,
                delegate: Delegate(folder: folder, model: model, vaultId: vaultId, isTargeted: $isTargeted)
            )
    }

    private struct Delegate: DropDelegate {
        let folder: String?
        let model: VaultBrowseViewModel
        let vaultId: String?
        @Binding var isTargeted: Bool

        /// What this app's drag would move here, read before any item loads.
        private var accepts: Bool {
            guard model.writer != nil, let vaultId else { return false }
            let moving = NoteFolderDrop.moving(NoteDrag.dragged, vaultId: vaultId, outline: model.outline, to: folder)
            return !moving.isEmpty
        }

        func validateDrop(info: DropInfo) -> Bool {
            info.hasItemsConforming(to: NoteFolderDrop.types) && model.writer != nil
        }

        func dropEntered(info: DropInfo) { isTargeted = accepts }

        func dropUpdated(info: DropInfo) -> DropProposal? {
            DropProposal(operation: accepts ? .move : .forbidden)
        }

        func dropExited(info: DropInfo) { isTargeted = false }

        func performDrop(info: DropInfo) -> Bool {
            isTargeted = false
            defer { NoteDrag.dropped() }
            guard accepts, let vaultId else { return false }
            let providers = info.itemProviders(for: NoteFolderDrop.types)
            Task { [folder, model] in await NoteFolderDrop.drop(providers, vaultId: vaultId, on: folder, model: model) }
            return true
        }
    }
}
