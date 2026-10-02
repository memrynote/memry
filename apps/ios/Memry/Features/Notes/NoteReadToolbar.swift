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
    @Binding var choosingCover: Bool
    @Binding var repositioningCover: Bool
    /// Raises the reminders section's add sheet; `nil` when read-only.
    let addReminder: (() -> Void)?
    let applyHistory: (BlockEdit?) async -> Void
    /// The note as text, for the share sheet (N802).
    let export: NoteExport
    /// The notes linking here, for the Backlinks sheet (N800).
    let backlinks: BacklinksViewModel
    /// Shows the find bar (N801).
    @Binding var finding: Bool
    /// Pushes a note: a backlink, or the copy Duplicate made.
    let open: ((NoteRoute) -> Void)?

    @Environment(\.requestVaultSync) private var requestVaultSync
    @State private var showingBacklinks = false
    @State private var choosingIcon = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                // Attachments and block inserts live in the keyboard toolbar,
                // so the top bar carries only the page menu.
                // Everything the bottom bar used to hold lives here now: the
                // keyboard toolbar owns editing at the caret, and one bottom
                // surface fewer leaves the page to the writing.
                ToolbarItem(placement: .topBarTrailing) {
                    NotePageMenu(
                        items: menuItems,
                        editing: editorModel.canEdit ? editingItems : nil
                    )
                }
            }
            .task { await actions.loadFavorite() }
            .sheet(isPresented: $showingBacklinks) {
                NoteBacklinksSheet(model: backlinks) { route in
                    showingBacklinks = false
                    open?(route)
                }
            }
            .sheet(isPresented: $choosingIcon) {
                EmojiPickerSheet(current: model.metadata?.icon) { chosen in
                    choosingIcon = false
                    Task {
                        await metadataModel.setIcon(chosen)
                        await model.reload()
                    }
                }
            }
    }

    private var menuItems: NotePageMenuItems {
        var items = NotePageMenuItems(
            folderPath: model.folderPath,
            export: export,
            find: { finding = true },
            backlinks: { showingBacklinks = true }
        )
        items.isFavorite = actions.isFavorite
        items.addReminder = addReminder
        if actions.canWrite {
            items.toggleFavorite = toggleFavorite
            items.rename = { renaming = true }
            items.duplicate = duplicate
            items.move = { moving = true }
            items.delete = { confirmingDelete = true }
        }
        if metadataModel.canEdit {
            items.changeIcon = { choosingIcon = true }
            items.changeCover = { choosingCover = true }
            if case .image = NoteCoverValue.of(model.metadata?.coverJson)?.kind {
                items.repositionCover = { repositioningCover = true }
            }
        }
        return items
    }

    private func toggleFavorite() {
        Task {
            await actions.toggleFavorite()
            requestVaultSync?()
        }
    }

    /// Copies the note, then opens the copy, as desktop's canvas Duplicate
    /// leaves the user on what it made.
    private func duplicate() {
        let title = model.displayTitle.isEmpty ? "Untitled" : model.displayTitle
        Task {
            if let id = await actions.duplicate(title: "\(title) copy") {
                requestVaultSync?()
                open?(NoteRoute(id: id))
            }
        }
    }

    private var editingItems: NotePageEditingItems {
        let session = editorModel.session
        return NotePageEditingItems(
            canUndo: session.history.canUndo,
            canRedo: session.history.canRedo,
            undo: { session.undo() },
            redo: { session.redo() }
        )
    }
}
