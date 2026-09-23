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
                ToolbarItem(placement: .topBarTrailing) {
                    NotePageMenu(
                        canWrite: actions.canWrite,
                        folderPath: model.folderPath,
                        rename: { renaming = true },
                        move: { moving = true },
                        delete: { confirmingDelete = true }
                    )
                }
                // The editing affordances, absent entirely on a read-only note
                // rather than present and refusing.
                if editorModel.canEdit {
                    ToolbarItem(placement: .topBarTrailing) {
                        BlockInsertMenu(
                            insert: { block in
                                Task {
                                    let id = await editorModel.insert(
                                        block.id, after: model.blocks.last?.id
                                    )
                                    if let id, let level = block.level {
                                        await editorModel.setProp(id, "level", String(level))
                                    }
                                    await model.reload()
                                }
                            }
                            // No `insertPicture`: the picture affordance is the
                            // adjacent toolbar item (N214), and a second entry
                            // here would be a duplicate path to the same picker.
                        )
                    }
                    // The inline nodes: a date, and a link to another note
                    // (N601, N602). Both land in the last block, which is where
                    // the caret is after the insert menu has been used; a caret
                    // the shell can address per-block is N501's.
                    ToolbarItem(placement: .bottomBar) {
                        DateMentionMenu { date, label, remindMe in
                            guard let blockId = model.blocks.last?.id else { return }
                            let end = Int(
                                model.blocks.last?.inline.map(\.text).joined().count ?? 0
                            )
                            Task {
                                await editorModel.insertDateMention(
                                    in: blockId,
                                    from: end,
                                    to: end,
                                    date: date,
                                    label: label,
                                    remindMe: remindMe
                                )
                                await model.reload()
                            }
                        }
                    }
                    ToolbarItem(placement: .bottomBar) {
                        WikiLinkMenu(
                            notes: model.vaultNotes,
                            create: nil,
                            insert: { title, alias, embed in
                                guard let blockId = model.blocks.last?.id else { return }
                                let end = Int(
                                    model.blocks.last?.inline.map(\.text).joined().count ?? 0
                                )
                                Task {
                                    await editorModel.insertWikiLink(
                                        in: blockId,
                                        from: end,
                                        to: end,
                                        title: title,
                                        displayAs: alias,
                                        embed: embed
                                    )
                                    await model.reload()
                                }
                            }
                        )
                    }
                    ToolbarItem(placement: .bottomBar) {
                        EditorHistoryControls(
                            stack: history,
                            undo: { Task { await applyHistory(history.popUndo()?.backward) } },
                            redo: { Task { await applyHistory(history.popRedo()?.forward) } }
                        )
                    }
                }
            }
    }
}
