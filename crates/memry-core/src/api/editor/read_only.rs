//! Why a document opens read-only ([`ReadOnly`]), read on the writer in the caller's turn.

use rusqlite::Connection;

use super::{EditorError, storage_error};
use crate::api::errors::StorageError;
use crate::api::excluded_paths::ExcludedPaths;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::Document;
use crate::domain::{note_files, vault_locks};
use crate::sync::body_debt;

/// Why a document opens read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnly {
    /// The note's file is large-file class, as the last read of it measured
    /// ([`crate::domain::note_files::is_large_file`]): the app shows it in the
    /// large-file viewer, and its document takes no edit.
    LargeFile,
    /// The note, or a folder above its file, is locked ([`crate::domain::vault_locks`]).
    Locked,
    /// The note's file is one the app never writes ([`ExcludedPaths`]).
    Excluded,
    /// The vault's database opened read-only ([`super::Health::persistent`] is false): no edit
    /// can be stored, so none is taken, and the file, which is written from the stored body,
    /// stays as it is (#4190).
    Database,
    /// The note is owed its server body ([`body_debt::is_owed`]) and its body holds nothing yet.
    /// Typing would start a root that shares no Yjs items with the server body, and the merge
    /// would hold both roots, of which the editor keeps one and deletes the other (#2536). It
    /// takes edits again once the pulled body lands, while the debt may still stand.
    BodyNotPulled,
}

/// Why `note_id` opens read-only for a reason its body does not decide, if it does. Read on the
/// writer, in the caller's turn: a class or a lock committed while an edit waited for the
/// writer refuses that edit, as does a pattern set meanwhile.
pub(super) fn read_only(
    conn: &Connection,
    note_id: &str,
    excluded: &ExcludedPaths,
) -> Result<Option<ReadOnly>, StorageError> {
    if note_files::is_large_file(conn, note_id)? {
        return Ok(Some(ReadOnly::LargeFile));
    }
    if conn.is_readonly(rusqlite::MAIN_DB).map_err(storage_error)? {
        return Ok(Some(ReadOnly::Database));
    }
    if vault_locks::is_note_locked(conn, note_id, None)? {
        return Ok(Some(ReadOnly::Locked));
    }
    if excluded.is_set()
        && note_files::by_id(conn, note_id)?.is_some_and(|file| excluded.covers(&file.path))
    {
        return Ok(Some(ReadOnly::Excluded));
    }
    Ok(None)
}

/// Whether `note_id` waits for its server body: owed a pull, with nothing in `document`'s body
/// yet ([`ReadOnly::BodyNotPulled`]).
pub(super) fn body_not_pulled(
    conn: &Connection,
    note_id: &str,
    document: &Document,
) -> Result<bool, EditorError> {
    Ok(body_debt::is_owed(conn, note_id)? && body_is_empty(document)?)
}
