//! Which notes' files are large-file class (table `note_large_files`, migration 23): the class
//! the desktop tier measured when it last read the file. The editor reads it to open the
//! document read-only and refuse its edits (`api::editor`); the thresholds are
//! `markdown::shared::markdown_class`'s. No row is note class.

use rusqlite::{Connection, OptionalExtension, params};

use super::failed;
use crate::api::errors::StorageError;

/// Whether the last read of the note's file found it large-file class.
pub fn is_large_file(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM note_large_files WHERE note_id = ?1",
        params![note_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

/// Records the class a read of the note's file just measured.
pub fn set_large_file(conn: &Connection, note_id: &str, large: bool) -> Result<(), StorageError> {
    let sql = if large {
        "INSERT OR IGNORE INTO note_large_files (note_id) VALUES (?1)"
    } else {
        "DELETE FROM note_large_files WHERE note_id = ?1"
    };
    conn.execute(sql, params![note_id])
        .map(|_| ())
        .map_err(failed)
}
