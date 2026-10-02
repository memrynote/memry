//
//  NoteReadToolbar.swift
//  The note screen's toolbar, lifted out of `NoteReadView`.
//
//  Its own file because the read view had grown past the length the linter
//  allows, and the toolbar is the part of it that is not about reading a
//  note: it is the attachment picker, the insert and inline menus, the page
//  actions and the undo controls.
//

import MemryCore
import SwiftUI

/// Everything the toolbar needs, as one modifier.
struct NoteReadToolbar: ViewModifier {
    let model: NoteReadViewModel
    let editorModel: NoteEditorViewModel
    let metadataModel: NoteMetadataViewModel
    let actions: NotePageActions
    let composer: NoteAttachmentComposer
    let history: EditorUndoStack
    @Binding var renaming: Bool
    @Binding var moving: Bool
    @Binding var confirmingDelete: Bool
    let applyHistory: (BlockEdit?) async -> Void
    /// The note as text, for the share sheet (N802).
    let export: NoteExport

    /// The page menu's link and date sheets, which insert at the end of the
    /// last block (the keyboard toolbar inserts at the caret).
    @State private var linking = false
    @State private var dating = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NoteAttachmentPicker(composer: composer) { _ in
                        // The reference list changed, so the bindings have to be
                        // read again: that is what makes the new picture appear
                        // in place rather than on the next note open.
                        Task { await model.refreshAttachments() }
                    }
                }
                // The editing affordances, absent entirely on a read-only note
                // rather than present and refusing.
                if editorModel.canEdit {
                    ToolbarItem(placement: .topBarTrailing) {
                        BlockInsertMenu(choose: choose)
                    }
                }
                // Everything the bottom bar used to hold lives here now: the
                // keyboard toolbar owns editing at the caret, and one bottom
                // surface fewer leaves the page to the writing.
                ToolbarItem(placement: .topBarTrailing) {
                    NotePageMenu(
                        canWrite: actions.canWrite,
                        folderPath: model.folderPath,
                        rename: { renaming = true },
                        move: { moving = true },
                        delete: { confirmingDelete = true },
                        editing: editorModel.canEdit ? editingItems : nil
                    )
                }
            }
            .sheet(isPresented: $linking) {
                WikiLinkSheet(
                    titles: model.vaultNotes.map(\.title),
                    insert: { kind in
                        linking = false
                        append(kind)
                    },
                    cancel: { linking = false }
                )
            }
            .sheet(isPresented: $dating) {
                DateMentionSheet(
                    insert: { value in
                        dating = false
                        append(.date(value))
                    },
                    cancel: { dating = false }
                )
            }
    }

    private var editingItems: NotePageEditingItems {
        let session = editorModel.session
        return NotePageEditingItems(
            canUndo: session.history.canUndo,
            canRedo: session.history.canRedo,
            undo: { session.undo() },
            redo: { session.redo() },
            linkToNote: { linking = true },
            mentionDate: { dating = true }
        )
    }

    /// A catalog row at the end of the note: a block after the last one, or
    /// the link and date sheets' paths.
    private func choose(_ row: BlockCatalog.Row) {
        switch row.action {
        case let .block(kind, level, props):
            Task {
                guard let id = await editorModel.insert(kind, after: model.blocks.last?.id) else { return }
                if let level { await editorModel.setProp(id, "level", String(level)) }
                for (name, value) in props.sorted(by: { $0.key < $1.key }) {
                    await editorModel.setProp(id, name, value)
                }
                await model.reload()
            }
        case .linkToNote:
            linking = true
        case let .date(remind):
            if let mention = BlockCatalog.mention(remind: remind) { append(mention.kind) }
        case .picture:
            break
        }
    }

    private func append(_ kind: EditorSuggestion.Kind) {
        guard let last = model.blocks.last(where: { $0.id != nil }) else { return }
        editorModel.session.append(kind, to: last)
    }
}
