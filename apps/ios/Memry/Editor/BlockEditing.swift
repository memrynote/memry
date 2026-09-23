//
//  BlockEditing.swift
//  The seam every editing surface writes through.
//
//  N302. One protocol, so the editor can be driven by a fake in tests and by
//  the core in production, and so the editor never holds a `Vault` directly.
//

import Foundation
import MemryCore

/// One note's body write surface.
///
/// **The shell sends an operation, never a node.** Node construction lives in
/// `crates/memry-core/src/crdt/node_shapes.rs` because a node y-prosemirror
/// cannot build is deleted silently (§12.5.0); a Swift surface that assembled
/// its own would be the one place that mistake could reappear.
protocol BlockEditing: Sendable {
    /// Applies one operation to a note's body.
    ///
    /// - Returns: `false` when the vault holds no live note by that id, which
    ///   is an answer rather than a failure. A block the body does not hold
    ///   **throws**: the note is here and the edit did not land, so a caller
    ///   that carried on would be showing a change it never made.
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool
}

/// The production editor: the core's own `NotesWriter`, over the shell's one
/// serial core queue.
struct CoreBlockEditor: BlockEditing {
    private let vault: Vault
    private let store: any SecureStore
    private let executor: CoreExecutor

    init(vault: Vault, store: any SecureStore, executor: CoreExecutor) {
        self.vault = vault
        self.store = store
        self.executor = executor
    }

    /// Minted per write rather than held, for the same reason
    /// ``CoreNotesWriter`` does it: a keychain locked when the edit happens is
    /// what matters, not whether it was locked when the screen opened.
    private func writer() throws -> NotesWriter {
        try vault.notesWriter(store: store)
    }

    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        try await executor.run { try writer().editBlock(noteId: noteId, edit: edit) }
    }
}
