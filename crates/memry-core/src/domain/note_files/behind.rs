//! The notes whose body moved after their row's stamp: an edit, or a merged page, the file has
//! not been written with ([`super::NoteFile::indexed_at`]).

use rusqlite::{Connection, params};

use super::failed;
use super::marks::moved_after_mark;
use crate::api::errors::StorageError;
use crate::crdt::update_log;

/// The SQL test, over a `note_files` row, that an entry of the note's body log or snapshot,
/// in either namespace ([`update_log`]), is stamped after the row: by its clock, or by the
/// row's mark ([`super::marks`]), which also names an entry stored in the stamp's millisecond.
pub(super) fn body_moved_after_stamp() -> String {
    let local = update_log::LOCAL_NAMESPACE_PREFIX;
    format!(
        "({} OR EXISTS (SELECT 1 FROM yjs_updates u
                   WHERE u.doc_id IN (note_files.note_id, '{local}' || note_files.note_id)
                     AND u.created_at > note_files.indexed_at)
          OR EXISTS (SELECT 1 FROM yjs_snapshots s
                      WHERE s.doc_id IN (note_files.note_id, '{local}' || note_files.note_id)
                        AND s.compacted_at > note_files.indexed_at))",
        moved_after_mark()
    )
}

/// Every note whose file may be behind its body, in id order: the row says the document
/// holds the file (a markdown row with a hash), and an entry of the note's body log or
/// snapshot, in either namespace ([`update_log`]), is stamped after the row
/// (`indexed_at`). The stamps are this device's clock at apply time, the same reading the
/// search index's watermark relies on (`domain::search::maintenance`).
///
/// A row's stamp is the time up to which it accounts for the body ([`NoteFile::indexed_at`]),
/// so this names every note whose body moved after that: an edit or a merged page whose
/// write-back never ran. By the clock, an entry stamped in the same millisecond as the row is
/// not counted, so the feed that recorded the row does not name its own note; the row's mark,
/// taken as the row is written, counts an entry stored after it in that millisecond too.
pub fn behind_bodies(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT note_id FROM note_files
              WHERE file_type = 'markdown' AND content_hash IS NOT NULL
                AND {}
              ORDER BY note_id",
            body_moved_after_stamp()
        ))
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Whether the note's body moved after its row's stamp ([`behind_bodies`], for one note whatever
/// its row's hashes): an edit, or a merged page, its file has not been written with. `false`
/// for a note without a row.
pub fn behind_body(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM note_files WHERE note_id = ?1 AND {})",
            body_moved_after_stamp()
        ),
        params![note_id],
        |row| row.get(0),
    )
    .map_err(failed)
}
