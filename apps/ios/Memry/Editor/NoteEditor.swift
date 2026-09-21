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

    // MARK: - Block boundaries (N501)

    /// Splits a block at `offset`: what is before the caret stays, what is
    /// after it becomes a new block below.
    ///
    /// **Two operations, in this order.** The tail is written into the new
    /// block *before* the head is truncated, so a failure between them leaves
    /// the text duplicated rather than destroyed. Duplicated text is a
    /// user-visible mistake they can fix; deleted text is not.
    @discardableResult
    func split(_ blockId: String, at offset: Int, text: String) async -> String? {
        guard let editor else { return nil }
        let cut = text.index(text.startIndex, offsetBy: min(offset, text.count))
        let head = String(text[text.startIndex..<cut])
        let tail = String(text[cut...])
        let newId = UUID().uuidString.lowercased()

        status = .saving
        do {
            _ = try await editor.edit(
                noteId: noteId,
                .insertParagraph(afterBlockId: blockId, text: tail, newBlockId: newId)
            )
            _ = try await editor.edit(noteId: noteId, .setText(blockId: blockId, text: head))
            drafts[blockId] = head
            drafts[newId] = tail
            status = .idle
            return newId
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
            return nil
        }
    }

    /// Merges a block into the one above it, which is Backspace at offset 0.
    ///
    /// - Returns: the offset the caret lands at in the block above — the
    ///   length of its text before the merge — so the caret sits where the
    ///   join happened rather than at either end.
    ///
    /// **The join is written before the block is removed**, for the same
    /// reason as ``split``: a failure between the two leaves the text twice
    /// rather than not at all.
    @discardableResult
    func merge(_ blockId: String, into previousId: String, text: String, previousText: String)
        async -> Int?
    {
        guard let editor else { return nil }
        status = .saving
        do {
            _ = try await editor.edit(
                noteId: noteId,
                .setText(blockId: previousId, text: previousText + text)
            )
            _ = try await editor.edit(noteId: noteId, .delete(blockId: blockId))
            drafts[previousId] = previousText + text
            drafts[blockId] = nil
            status = .idle
            return previousText.count
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
            return nil
        }
    }

    /// Deletes a block outright.
    func delete(_ blockId: String) async {
        await run(.delete(blockId: blockId)) { [weak self] in self?.drafts[blockId] = nil }
    }

    // MARK: - The rest of the operations (N500, N503 - N507)

    /// Changes a block's type (N503). `level` rides along for a heading,
    /// because "Heading 2" is one choice to a user and two operations here.
    func turnInto(_ blockId: String, kind: String, level: Int? = nil) async {
        guard let editor else { return }
        status = .saving
        do {
            _ = try await editor.edit(noteId: noteId, .turnInto(blockId: blockId, kind: kind))
            if let level {
                _ = try await editor.edit(
                    noteId: noteId,
                    .setProp(blockId: blockId, name: "level", value: String(level))
                )
            }
            status = .idle
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
        }
    }

    /// Sets one prop: a callout's `type`, a code block's `language`, a
    /// toggle's `open`, a check item's `checked`, a colour, an alignment.
    ///
    /// The value travels as text and the **core** converts it to the prop's
    /// declared type, which is why a boolean written here still reads as a
    /// boolean (N408).
    func setProp(_ blockId: String, _ name: String, _ value: String) async {
        await run(.setProp(blockId: blockId, name: name, value: value))
    }

    func insert(_ kind: String, after blockId: String?, text: String = "") async -> String? {
        guard let editor else { return nil }
        let newId = UUID().uuidString.lowercased()
        status = .saving
        do {
            _ = try await editor.edit(
                noteId: noteId,
                .insertBlock(
                    kind: kind, afterBlockId: blockId, text: text, newBlockId: newId
                )
            )
            status = .idle
            return newId
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
            return nil
        }
    }

    func duplicate(_ blockId: String) async -> String? {
        guard let editor else { return nil }
        let newId = UUID().uuidString.lowercased()
        status = .saving
        do {
            _ = try await editor.edit(
                noteId: noteId, .duplicate(blockId: blockId, newBlockId: newId)
            )
            status = .idle
            return newId
        } catch {
            status = .failed(ErrorMapping.userFacing(error))
            return nil
        }
    }

    func move(_ blockId: String, after: String?) async {
        await run(.moveBlock(blockId: blockId, afterBlockId: after))
    }

    /// Tab and Shift-Tab. A block with no previous sibling **cannot** indent,
    /// which the core refuses rather than inventing a parent for.
    func indent(_ blockId: String) async { await run(.indent(blockId: blockId)) }
    func outdent(_ blockId: String) async { await run(.outdent(blockId: blockId)) }

    // MARK: - Marks (N504)

    /// Applies a mark over a selection.
    ///
    /// This is the operation that makes formatting possible without losing
    /// the rest of the block: `SetText` replaces everything and drops every
    /// mark, so a toolbar built on it could only ever format a whole block.
    func mark(
        _ blockId: String, from start: Int, to end: Int, _ mark: String, value: String? = nil
    ) async {
        await run(
            .setMark(
                blockId: blockId, start: UInt32(max(0, start)), end: UInt32(max(0, end)),
                mark: mark, value: value
            )
        )
    }

    func unmark(_ blockId: String, from start: Int, to end: Int, _ mark: String) async {
        await run(
            .removeMark(
                blockId: blockId, start: UInt32(max(0, start)), end: UInt32(max(0, end)),
                mark: mark
            )
        )
    }

    // MARK: - Tables (N505)

    /// A cell is addressed by its table plus row and column, because a cell
    /// carries no id of its own (Q1).
    func setCell(_ tableId: String, row: Int, column: Int, text: String) async {
        await run(
            .setCellText(
                tableId: tableId, row: UInt32(row), column: UInt32(column), text: text
            )
        )
    }

    func setCellProp(_ tableId: String, row: Int, column: Int, _ name: String, _ value: String)
        async
    {
        await run(
            .setCellProp(
                tableId: tableId, row: UInt32(row), column: UInt32(column), name: name,
                value: value
            )
        )
    }

    /// Ticks or unticks one inline checkbox in a cell (N605).
    ///
    /// Addressed by position because an inline checkbox has no id: it is an
    /// inline node inside the cell's paragraph, not a block (§12.7.1).
    func setCellCheckbox(
        _ tableId: String, row: Int, column: Int, index: Int, checked: Bool
    ) async {
        await run(
            .setCellCheckbox(
                tableId: tableId, row: UInt32(row), column: UInt32(column),
                index: UInt32(index), checked: checked
            )
        )
    }

    func insertRow(_ tableId: String, at index: Int) async {
        await run(.insertRow(tableId: tableId, at: UInt32(index)))
    }
    func deleteRow(_ tableId: String, at index: Int) async {
        await run(.deleteRow(tableId: tableId, at: UInt32(index)))
    }
    func insertColumn(_ tableId: String, at index: Int) async {
        await run(.insertColumn(tableId: tableId, at: UInt32(index)))
    }
    func deleteColumn(_ tableId: String, at index: Int) async {
        await run(.deleteColumn(tableId: tableId, at: UInt32(index)))
    }

    /// Applies one operation as given.
    ///
    /// The undo path's entry point: a step already knows the exact operation
    /// that reverses it, so it does not go back through the helpers that mint
    /// ids and compute text.
    func apply(_ edit: BlockEdit) async {
        await run(edit)
    }

    /// One operation, with the status handling every caller would repeat.
    private func run(_ edit: BlockEdit, then finish: (() -> Void)? = nil) async {
        guard let editor else { return }
        status = .saving
        do {
            _ = try await editor.edit(noteId: noteId, edit)
            finish?()
            status = .idle
        } catch {
            Log.storage.error("a block edit did not land")
            status = .failed(ErrorMapping.userFacing(error))
        }
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
