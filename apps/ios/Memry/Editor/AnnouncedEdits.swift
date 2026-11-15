//
//  AnnouncedEdits.swift
//  #4377: two panes on one note. Both write to the note's one document in
//  the core, through the vault's one editor. Each page still draws the
//  blocks it last read, so an edit that lands is announced, and every other
//  page on the note re-reads at once (`NotePageLoad`) instead of at the next
//  sync pass. Its own typing merges on the document as a peer's does: a
//  block with unsaved typing commits only its change (`EditorSession.commit`).
//

import Foundation
import MemryCore

/// A page's editor, announcing each edit that lands.
struct AnnouncedEdits: BlockEditing {
    /// Posted on the main actor with the note id as `object` and the writing
    /// page's `NoteEditorViewModel.source` under `sourceKey`.
    static let bodyChanged = Notification.Name("memry.note.bodyChanged")
    static let sourceKey = "source"

    let editor: any BlockEditing
    let source: UUID

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        let landed = try await editor.edit(noteId: noteId, edit)
        if landed { await announce(noteId) }
        return landed
    }

    func snapshot(noteId: String, blockId: String) async throws -> String? {
        try await editor.snapshot(noteId: noteId, blockId: blockId)
    }

    func edit(
        noteId: String, blockId: String, locating locate: @escaping @Sendable ([InlineRun]?) -> BlockEdit?
    ) async throws -> (edit: BlockEdit, landed: Bool)? {
        let located = try await editor.edit(noteId: noteId, blockId: blockId, locating: locate)
        if located?.landed == true { await announce(noteId) }
        return located
    }

    var movesBlocksBetweenNotes: Bool { editor.movesBlocksBetweenNotes }

    func appendSnapshot(_ snapshot: String, toNote noteId: String) async throws -> Bool {
        let landed = try await editor.appendSnapshot(snapshot, toNote: noteId)
        if landed { await announce(noteId) }
        return landed
    }

    @MainActor private func announce(_ noteId: String) {
        NotificationCenter.default.post(name: Self.bodyChanged, object: noteId, userInfo: [Self.sourceKey: source])
    }
}
