//! `attachment_files`: the attachment files this device knows the server has
//! (`attachment-files.ts`, #2651). One row per (owner, vault-relative path),
//! written when an upload succeeds or a download lands. Attachment ids are
//! random per upload, so this record is the only way to tell a new file on a
//! note that already holds references from one already up.
//!
//! A row with a `NULL` attachment id is a file counted as known when an older
//! note was first seen: nothing says whether it went up, and uploading it again
//! would duplicate it. A row with the path [`COUNTED_EMPTY`] marks a note
//! counted while it had no file on disk. Paths are vault-relative and
//! `/`-separated; the caller drops every path outside the vault before it
//! reaches this module.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::failed;
use crate::api::errors::StorageError;

/// `COUNTED_EMPTY` (`attachment-files.ts:27`).
pub const COUNTED_EMPTY: &str = "";

/// One row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    pub path: String,
    /// `None` for a file counted as known, never uploaded by this device.
    pub attachment_id: Option<String>,
}

/// Every row of `owner_id`, by path.
pub fn records(conn: &Connection, owner_id: &str) -> Result<Vec<StoredFile>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT path, attachment_id FROM attachment_files WHERE note_id = ?1 ORDER BY path",
        )
        .map_err(failed)?;
    statement
        .query_map(params![owner_id], |row| {
            Ok(StoredFile {
                path: row.get(0)?,
                attachment_id: row.get(1)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Owners with at least one row: recorded uploads, downloads, or a count
/// (`notesWithRecords`).
pub fn owners_with_records(conn: &Connection) -> Result<BTreeSet<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT DISTINCT note_id FROM attachment_files")
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Records a file the server has under `attachment_id` (`insertRecord`),
/// replacing what the row said before.
pub fn record(
    conn: &Connection,
    owner_id: &str,
    path: &str,
    attachment_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO attachment_files (note_id, path, attachment_id, recorded_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (note_id, path) DO UPDATE SET
           attachment_id = excluded.attachment_id,
           recorded_at = excluded.recorded_at",
        params![owner_id, path, attachment_id, now_ms],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Counts an older note's files as known (`countNoteFiles`): one row with no
/// attachment id per path a row does not hold yet, or one [`COUNTED_EMPTY`]
/// row for a note with none. A recorded row is never overwritten.
pub fn count_known(
    conn: &Connection,
    owner_id: &str,
    paths: &[String],
    now_ms: i64,
) -> Result<(), StorageError> {
    let mut statement = conn
        .prepare(
            "INSERT INTO attachment_files (note_id, path, attachment_id, recorded_at)
             VALUES (?1, ?2, NULL, ?3)
             ON CONFLICT (note_id, path) DO NOTHING",
        )
        .map_err(failed)?;
    let empty = [COUNTED_EMPTY.to_owned()];
    let paths = if paths.is_empty() { &empty[..] } else { paths };
    for path in paths {
        statement
            .execute(params![owner_id, path, now_ms])
            .map_err(failed)?;
    }
    Ok(())
}

/// Moves the row of `from` to `to` (a renamed file, `takeOverRenamedRecord`,
/// or a download placed at its linked path, `moveRecord`). A row already at
/// `to` is stale, since the file there is the moved one: it goes even when
/// `from` has no row, as `moveRecord` deletes it first. The move is one
/// statement, so a crash leaves either the old row or the new one.
pub fn move_record(
    conn: &Connection,
    owner_id: &str,
    from: &str,
    to: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let moved = conn
        .execute(
            "UPDATE OR REPLACE attachment_files SET path = ?3, recorded_at = ?4
             WHERE note_id = ?1 AND path = ?2",
            params![owner_id, from, to, now_ms],
        )
        .map_err(failed)?;
    if moved == 0 {
        conn.execute(
            "DELETE FROM attachment_files WHERE note_id = ?1 AND path = ?2",
            params![owner_id, to],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// The path this device recorded for `attachment_id` of `owner_id`
/// (`recordedFileOf`, before its disk check): the latest record when there are
/// several.
pub fn path_of(
    conn: &Connection,
    owner_id: &str,
    attachment_id: &str,
) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT path FROM attachment_files
         WHERE note_id = ?1 AND attachment_id = ?2 AND path != ''
         ORDER BY recorded_at DESC, path
         LIMIT 1",
        params![owner_id, attachment_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}
