import MemryCore

@testable import Memry

// The block walk, defaulted **for fakes only**.
//
// `NotesReading` gained `blocks(id:)` when the core did. Every scripted reader
// in this target answers about text, and none of them is testing the block
// walk — that is asserted in Rust, against the committed `text-extract` class,
// where both walks can be compared over one real document.
//
// The default lives here and **not** in the production protocol on purpose: a
// default in `VaultBrowse.swift` would let a real reader forget to implement
// it and silently render every note as bodyless. `CoreNotesReader` has no
// default to fall back on, so the compiler is what holds it to the surface.
extension NotesReading {
    func blocks(id: String) async throws -> [Block]? { [] }

    /// No table, for the same reason: the table read is asserted in Rust
    /// against a real document, and a fake answering with an empty
    /// `TableContent` would claim a note holds a table with no rows.
    func table(id: String, blockId: String) async throws -> TableContent? { nil }

    /// No attachments, for the same reason: a fake claiming a note has none
    /// would let a test pass over an attachment row that was never asked for.
    func attachments(id: String) async throws -> [CachedAttachment] { [] }

    /// Nothing binds, which is what a device that has fetched no manifest
    /// looks like — and is the answer that draws a placeholder rather than a
    /// wrong picture.
    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        .unknown
    }

    /// Unread rather than empty, for the same reason the production screen
    /// keeps the two apart: a fake answering "this note has no tags" would let
    /// a test pass over a tag row that was never asked for.
    func metadata(id: String) async throws -> NoteMetadata? { nil }

    /// Every link is broken until a test scripts otherwise — which is the
    /// honest default for a reader holding no notes.
    func resolveWikiTarget(_ target: String) async throws -> String? { nil }
}

