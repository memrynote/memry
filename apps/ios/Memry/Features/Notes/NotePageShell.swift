//
//  NotePageShell.swift
//  Find in note, the attachments list, and the page overflow menu.
//
//  N801, N805, N808.
//

import MemryCore
import Observation
import SwiftUI
import UIKit

// MARK: - N805, the attachments on a note

/// Everything this vault knows one note references.
///
/// **An empty list is not "this note has no attachments."** It is also what a
/// note whose references have never arrived looks like, because an absent
/// `attachmentReferences` means "this sender does not know" (§14.7). The
/// screen says which of the two it is showing rather than rendering both the
/// same way.
struct NoteAttachmentsList: View {
    let attachments: [CachedAttachment]
    var remove: ((String) async -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if attachments.isEmpty {
                Text("This device does not know of any attachment on this note.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                ForEach(attachments, id: \.attachmentId) { attachment in
                    HStack(spacing: Tokens.Space.small) {
                        Image(systemName: symbol(for: attachment.mimeType))
                            .foregroundStyle(Tokens.Text.secondary.color)
                        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                            Text(attachment.filename ?? "Untitled attachment")
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            Text(subtitle(for: attachment))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                        Spacer()
                        if let remove {
                            Button(role: .destructive) {
                                Task { await remove(attachment.attachmentId) }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .accessibilityLabel(
                                "Remove \(attachment.filename ?? "this attachment")"
                            )
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Downloaded or not, said plainly. A row with no bytes is waiting rather
    /// than broken (FR-045).
    private func subtitle(for attachment: CachedAttachment) -> String {
        guard attachment.localPath != nil else { return "Not downloaded yet" }
        // A size this device has not been told is **unknown**, not zero: the
        // manifest may not have arrived, and "0 bytes" would be a claim.
        guard let size = attachment.remoteSize else { return "Downloaded" }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    private func symbol(for mimeType: String?) -> String {
        guard let mimeType else { return "doc" }
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.hasPrefix("video/") { return "film" }
        return "doc"
    }
}

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
        if items.changeIcon != nil || items.changeCover != nil {
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
    var delete: (() -> Void)?
}

/// The editing entries of the page menu.
struct NotePageEditingItems {
    let canUndo: Bool
    let canRedo: Bool
    let undo: () -> Void
    let redo: () -> Void
}

/// The page menu's write actions (N808).
///
/// Its own model rather than more state on the read view, which is already
/// the longest file in the feature: rename, move and delete each need a
/// failure path, and three more `@State` flags plus three `Task` blocks would
/// have gone somewhere that is about reading a note.
@MainActor
@Observable
final class NotePageActions {
    enum Status: Equatable {
        case idle
        case working
        case failed(UserFacingError)
    }

    private let noteId: String
    private let writer: (any NotesWriting)?

    private(set) var status: Status = .idle
    /// Whether the note is in the sidebar's bookmarks (desktop's favorites).
    private(set) var isFavorite = false
    /// `true` once the note is gone, so the caller can leave the screen
    /// rather than showing a note that no longer exists.
    private(set) var deleted = false

    init(noteId: String, writer: (any NotesWriting)?) {
        self.noteId = noteId
        self.writer = writer
    }

    var canWrite: Bool { writer != nil }

    func rename(to title: String) async {
        guard let writer else { return }
        await run { try await writer.rename(id: noteId, title: title) }
    }

    /// `nil` is the vault root, and it travels as an explicit null so every
    /// other device does not keep the old folder (§13.4).
    func move(to folderPath: String?) async {
        guard let writer else { return }
        await run { try await writer.move(id: noteId, folderPath: folderPath) }
    }

    func delete() async {
        guard let writer else { return }
        await run { try await writer.delete(id: noteId) }
        if status == .idle { deleted = true }
    }

    func loadFavorite() async {
        guard let writer else { return }
        isFavorite = (try? await writer.isBookmarked(itemType: "note", itemId: noteId)) ?? false
    }

    func toggleFavorite() async {
        guard let writer else { return }
        await run { isFavorite = try await writer.toggleBookmark(itemType: "note", itemId: noteId) }
    }

    /// Copies the note beside itself and returns the copy's id.
    func duplicate(title: String) async -> String? {
        guard let writer else { return nil }
        var copy: String?
        await run { copy = try await writer.duplicate(id: noteId, title: title) }
        return copy
    }

    func dismissFailure() { status = .idle }

    private func run(_ work: () async throws -> Void) async {
        status = .working
        do {
            try await work()
            status = .idle
        } catch {
            Log.storage.error("a note page action did not land")
            status = .failed(ErrorMapping.userFacing(error))
        }
    }
}

/// Where a note can be moved to (N808).
///
/// The vault root is offered as its own row rather than as an empty entry,
/// because "no folder" is a real destination and §13.4's explicit null is how
/// it travels.
struct NoteFolderPicker: View {
    let current: String?
    let choose: (String?) -> Void

    /// Every folder in the vault. Handed in rather than read here, so this
    /// view does no I/O of its own.
    var folders: [FolderSummary] = []

    var body: some View {
        NavigationStack {
            List {
                Button {
                    choose(nil)
                } label: {
                    Label("Vault root", systemImage: "tray")
                }
                .disabled(current == nil)

                ForEach(folders, id: \.path) { folder in
                    Button {
                        choose(folder.path)
                    } label: {
                        Label(folder.path, systemImage: "folder")
                    }
                    .disabled(folder.path == current)
                }
            }
            .navigationTitle("Move to folder")
        }
    }
}

// MARK: - N800, the backlinks section
