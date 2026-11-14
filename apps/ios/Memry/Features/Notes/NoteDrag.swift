import MemryCore
import SwiftUI
import UniformTypeIdentifiers

// #4357. Notes and drag and drop on iPad. A note row drags out as the plain
// text "Share a copy" hands over, plus the note's `memry://note/<id>` link
// (`NoteRelationValue.uri`, `relation-uri.ts`). A folder in the Notes sidebar
// takes a dragged note and moves it with the "Move to folder" operation
// (`VaultBrowseViewModel.moveNote`), so a drop and the menu write the same.

/// The drag source side.
enum NoteDrag {
    /// The note being dragged inside this app, read by the folder targets to
    /// refuse its own folder while the drag hovers, before any item loads.
    /// A drop still checks the note it actually loads.
    @MainActor static var dragged: NoteSummary?

    /// The plain text first, for apps that take text, then the link. The
    /// text is read only when a receiver asks for it: a drop on a folder
    /// loads the link alone, and no body is fetched for it.
    @MainActor
    static func provider(for note: NoteSummary, text: @escaping @MainActor () async -> String?) -> NSItemProvider {
        dragged = note
        let provider = NSItemProvider()
        provider.suggestedName = note.title
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

    func body(content: Content) -> some View {
        if LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass) == .regular {
            content.onDrag {
                NoteDrag.provider(for: note) { [model, id = note.id] in
                    await model.exportNote(id: id)?.contents
                }
            }
        } else {
            content
        }
    }
}

/// The drop target side's decisions, kept pure for tests.
enum NoteFolderDrop {
    /// The note a dropped `memry://note/<id>` link names.
    static func noteId(in url: URL) -> String? {
        guard url.scheme == "memry", url.host() == "note" else { return nil }
        let id = url.lastPathComponent
        return id.isEmpty || id == "/" ? nil : id
    }

    /// Whether a note in `current` moves when dropped on `folder` (`nil` is
    /// the vault root). Not onto the folder it is already in, which the
    /// "Move to folder" menu leaves out too.
    static func moves(from current: String?, to folder: String?) -> Bool {
        (current ?? "") != (folder ?? "")
    }

    /// Reads the dropped link and answers the note it names, if this vault
    /// holds it.
    @MainActor
    static func note(from provider: NSItemProvider, in outline: VaultOutline?) async -> NoteSummary? {
        let url: URL? = await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                continuation.resume(returning: (object as? NSURL) as URL?)
            }
        }
        guard let id = url.flatMap(noteId(in:)) else { return nil }
        return outline?.allNotes.first { $0.id == id }
    }
}

/// A Notes sidebar row that takes a dropped note: the tint marks it while a
/// note that would move hovers, and the drop moves the note there.
struct NoteFolderDropTarget: ViewModifier {
    /// `nil` is the vault root.
    let folder: String?
    let model: VaultBrowseViewModel

    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .background {
                if isTargeted {
                    RoundedRectangle(cornerRadius: Tokens.Radius.small)
                        .strokeBorder(Tokens.Tint.base.color, lineWidth: 2)
                }
            }
            .onDrop(of: [.url], delegate: Delegate(folder: folder, model: model, isTargeted: $isTargeted))
    }

    private struct Delegate: DropDelegate {
        let folder: String?
        let model: VaultBrowseViewModel
        @Binding var isTargeted: Bool

        private var accepts: Bool {
            guard model.writer != nil else { return false }
            guard let dragged = NoteDrag.dragged else { return true }
            return NoteFolderDrop.moves(from: dragged.folderPath, to: folder)
        }

        func validateDrop(info: DropInfo) -> Bool {
            info.hasItemsConforming(to: [.url]) && model.writer != nil
        }

        func dropEntered(info: DropInfo) { isTargeted = accepts }

        func dropUpdated(info: DropInfo) -> DropProposal? {
            DropProposal(operation: accepts ? .move : .forbidden)
        }

        func dropExited(info: DropInfo) { isTargeted = false }

        func performDrop(info: DropInfo) -> Bool {
            isTargeted = false
            guard accepts, let provider = info.itemProviders(for: [.url]).first else { return false }
            let folder = folder
            let model = model
            Task {
                guard let note = await NoteFolderDrop.note(from: provider, in: model.outline),
                      NoteFolderDrop.moves(from: note.folderPath, to: folder) else { return }
                await model.moveNote(id: note.id, to: folder)
            }
            return true
        }
    }
}
