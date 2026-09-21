//
//  NoteEditor.swift
//  N302 — one editable paragraph, end to end through `Notes.editBlock`.
//
//  The skeleton of the surface N300 chose. It is deliberately small: one
//  block type, one operation, the whole path from a keystroke to a CRDT
//  update. Phase F grows it; this proves the path exists.
//

import Foundation
import MemryCore
import Observation

/// The editing state of one note's body.
@MainActor
@Observable
final class NoteEditorViewModel {
    /// What the editor is currently doing, so the screen can say so rather
    /// than guess.
    enum Status: Equatable {
        case idle
        case saving
        /// The edit did not land. **The block still shows what the user
        /// typed**, because discarding it would lose their work to report a
        /// failure about losing their work.
        case failed(UserFacingError)
    }

    private let noteId: String
    private let editor: (any BlockEditing)?

    private(set) var status: Status = .idle

    /// The blocks as the editor holds them, keyed by block id.
    ///
    /// Held separately from the read model's blocks because a block being
    /// typed into is ahead of the document until it commits.
    private(set) var drafts: [String: String] = [:]

    init(noteId: String, editor: (any BlockEditing)?) {
        self.noteId = noteId
        self.editor = editor
    }

    /// Whether this note can be edited at all.
    ///
    /// **Absent rather than disabled**: with no editor there is nothing to
    /// write through, and a keyboard that opens onto a read-only note is a
    /// worse answer than no keyboard.
    var canEdit: Bool { editor != nil }

    /// The text to show for a block: the draft if the user has touched it,
    /// otherwise what the document says.
    func text(for blockId: String, fallback: String) -> String {
        drafts[blockId] ?? fallback
    }

    /// Records what the user typed without writing it.
    func draft(_ text: String, for blockId: String) {
        drafts[blockId] = text
    }

    /// Commits one block's text.
    ///
    /// Returns without writing when the text has not changed, because an
    /// unchanged commit is still a CRDT update and an outbox row (FR-030) —
    /// tapping into a block and back out must not enqueue a push.
    func commit(_ text: String, for blockId: String, current: String) async {
        guard let editor else { return }
        drafts[blockId] = text
        guard text != current else {
            status = .idle
            return
        }

        status = .saving
        do {
            let landed = try await editor.edit(
                noteId: noteId,
                .setText(blockId: blockId, text: text)
            )
            if landed {
                status = .idle
            } else {
                // The note is gone. Not an error the user caused, and not
                // something a retry fixes. The existing copy for exactly this
                // situation rather than a second sentence saying the same
                // thing in different words.
                status = .failed(ErrorMapping.unknownNote)
            }
        } catch {
            Log.storage.error("a block edit did not land")
            status = .failed(ErrorMapping.userFacing(error))
        }
    }

    /// Inserts a paragraph after `blockId` and returns its new id.
    ///
    /// The id is minted here rather than read back, which is what lets the
    /// caret move into the new block without a second read.
    func insertParagraph(after blockId: String?) async -> String? {
        guard let editor else { return nil }
        let newId = UUID().uuidString.lowercased()
        status = .saving
        do {
            _ = try await editor.edit(
                noteId: noteId,
                .insertParagraph(afterBlockId: blockId, text: "", newBlockId: newId)
            )
            status = .idle
            drafts[newId] = ""
            return newId
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
            return nil
        }
    }

    func dismissFailure() {
        status = .idle
    }
}

/// What a block view needs to become editable, as plain closures.
///
/// A struct of closures rather than the view model itself, so
/// `NoteBlockView` — which is in the read feature and has no business knowing
/// about an editor — depends on three functions instead of on a type.
struct NoteEditingBridge {
    /// The text to show: the draft if the user has touched this block,
    /// otherwise what the document says.
    let text: (String, String) -> String
    /// Commit this block's text. The third argument is what the document
    /// currently holds, so an unchanged commit can write nothing.
    let commit: (String, String, String) -> Void
    /// Return pressed at the end of this block: a new paragraph after it.
    let insertAfter: (String) -> Void

    @MainActor
    init(model: NoteEditorViewModel, didChange: @escaping () async -> Void) {
        text = { id, fallback in model.text(for: id, fallback: fallback) }
        commit = { id, text, current in
            Task { @MainActor in
                await model.commit(text, for: id, current: current)
                await didChange()
            }
        }
        insertAfter = { id in
            Task { @MainActor in
                _ = await model.insertParagraph(after: id)
                await didChange()
            }
        }
    }
}
