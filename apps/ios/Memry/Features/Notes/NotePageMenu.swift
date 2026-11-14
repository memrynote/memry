//
//  NotePageMenu.swift
//  The note page's overflow menu and what it offers, split out of
//  `NotePageShell.swift` at the line ceiling.
//
//  N808.
//

import SwiftUI
import UIKit

// MARK: - N808, the page overflow menu

/// The note page's overflow menu, in groups: editing, looking around the
/// note, organising it, how it looks, taking it elsewhere, and delete last.
///
/// Every write is optional and absent rather than disabled when this device
/// cannot make it (no signing identity, a read-only note), so the menu never
/// offers something that would fail.
struct NotePageMenu: View {
    let items: NotePageMenuItems
    /// Undo and redo, which used to be the page's bottom bar. Links and
    /// date mentions are inserted from the editor. `nil` on a read-only note.
    var editing: NotePageEditingItems?

    var body: some View {
        Menu {
            if let editing {
                Section {
                    Button(action: editing.undo) {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                    }
                    .disabled(!editing.canUndo)
                    Button(action: editing.redo) {
                        Label("Redo", systemImage: "arrow.uturn.forward")
                    }
                    .disabled(!editing.canRedo)
                }
            }
            Section {
                Button(action: items.find) {
                    Label("Find in note", systemImage: "magnifyingglass")
                }
                Button(action: items.backlinks) {
                    Label("Backlinks", systemImage: "arrow.down.left")
                }
            }
            organise
            appearance
            Section {
                ShareLink(item: items.export.contents, subject: Text(items.export.title)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                ShareLink(
                    item: NoteExportFile(export: items.export),
                    preview: SharePreview(items.export.filename)
                ) {
                    Label("Export", systemImage: "arrow.down.doc")
                }
                .accessibilityLabel("Export this note as a text file")
                Button {
                    // The vault-relative path, which is what a user would paste
                    // somewhere else. The root is a note with no folder.
                    UIPasteboard.general.string = items.folderPath ?? ""
                } label: {
                    Label("Copy path", systemImage: "doc.on.doc")
                }
                .disabled(items.folderPath == nil)
            }
            if let delete = items.delete {
                Section {
                    Button(role: .destructive, action: delete) {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("More actions for this note")
    }

    @ViewBuilder
    private var organise: some View {
        Section {
            if let toggleFavorite = items.toggleFavorite {
                Button(action: toggleFavorite) {
                    if items.isFavorite {
                        Label("Remove from favorites", systemImage: "star.slash")
                    } else {
                        Label("Add to favorites", systemImage: "star")
                    }
                }
            }
            if let addReminder = items.addReminder {
                Button(action: addReminder) {
                    Label("Reminder", systemImage: "bell")
                }
            }
            if let rename = items.rename {
                Button(action: rename) {
                    Label("Rename", systemImage: "pencil")
                }
            }
            if let duplicate = items.duplicate {
                Button(action: duplicate) {
                    Label("Duplicate", systemImage: "plus.square.on.square")
                }
            }
            if let move = items.move {
                Button(action: move) {
                    Label("Move to", systemImage: "folder")
                }
            }
        }
    }

    @ViewBuilder
    private var appearance: some View {
        if items.changeIcon != nil || items.changeCover != nil || items.toggleFullWidth != nil {
            Section {
                if let changeIcon = items.changeIcon {
                    Button(action: changeIcon) {
                        Label("Change icon", systemImage: "face.smiling")
                    }
                }
                if let changeCover = items.changeCover {
                    Button(action: changeCover) {
                        Label("Change cover", systemImage: "photo")
                    }
                }
                if let repositionCover = items.repositionCover {
                    Button(action: repositionCover) {
                        Label("Reposition cover", systemImage: "arrow.up.and.down")
                    }
                }
                if let toggleFullWidth = items.toggleFullWidth {
                    Toggle(isOn: Binding(get: { items.isFullWidth }, set: { _ in toggleFullWidth() })) {
                        Label("Full width", systemImage: "arrow.left.and.right")
                    }
                    .accessibilityIdentifier("note.more.fullWidth")
                }
            }
        }
    }
}

/// What the page menu offers. A `nil` action is one this device cannot take
/// on this note, and its row is left out.
struct NotePageMenuItems {
    let folderPath: String?
    let export: NoteExport
    let find: () -> Void
    let backlinks: () -> Void
    var isFavorite = false
    var toggleFavorite: (() -> Void)?
    var addReminder: (() -> Void)?
    var rename: (() -> Void)?
    var duplicate: (() -> Void)?
    var move: (() -> Void)?
    var changeIcon: (() -> Void)?
    var changeCover: (() -> Void)?
    var repositionCover: (() -> Void)?
    /// Whether the page runs full width now, override or not.
    var isFullWidth = false
    var toggleFullWidth: (() -> Void)?
    var delete: (() -> Void)?
}

/// The editing entries of the page menu.
struct NotePageEditingItems {
    let canUndo: Bool
    let canRedo: Bool
    let undo: () -> Void
    let redo: () -> Void
}
