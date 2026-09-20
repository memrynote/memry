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

    /// Unread rather than empty, for the same reason the production screen
    /// keeps the two apart: a fake answering "this note has no tags" would let
    /// a test pass over a tag row that was never asked for.
    func metadata(id: String) async throws -> NoteMetadata? { nil }

    /// Every link is broken until a test scripts otherwise — which is the
    /// honest default for a reader holding no notes.
    func resolveWikiTarget(_ target: String) async throws -> String? { nil }
}

