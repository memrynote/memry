//! The update-log mark of each row's stamp (table `note_file_marks`, migration 22): one past the
//! highest sequence each namespace of the note's body log had claimed when the row was stamped
//! ([`LogMark`]). An entry at or above it was stored after the stamp, in the stamp's millisecond
//! too. A mark counts only while its `indexed_at` is the row's stamp.

use rusqlite::{Connection, OptionalExtension, params};

use super::failed;
use crate::api::errors::StorageError;
use crate::crdt::update_log::LOCAL_NAMESPACE_PREFIX;

/// How far a note's document has come: one past the highest sequence each namespace of its
/// log has claimed, a fold point included. Every update stored moves it and a fold does not,
/// so two equal marks mean the document took no edit in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogMark {
    pub(crate) server: i64,
    pub(crate) local: i64,
}

/// Which mark a stamp write records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StampMark {
    /// The log as it is when the row is written: the caller read the body just before.
    Now,
    /// A mark the caller took before it read the body (the write-back's).
    At(LogMark),
    /// The row keeps the stamp it had, and its mark with it.
    Kept,
}

/// Records the mark of the row of `note_id` stamped `indexed_at`.
pub(super) fn write(
    conn: &Connection,
    note_id: &str,
    indexed_at: i64,
    mark: StampMark,
) -> Result<(), StorageError> {
    let next = |doc_id: &str| {
        format!(
            "(SELECT MAX(high) + 1 FROM (
                SELECT COALESCE(MAX(seq), 0) AS high FROM yjs_updates WHERE doc_id = {doc_id}
                UNION ALL
                SELECT COALESCE(MAX(last_seq), 0) FROM yjs_snapshots WHERE doc_id = {doc_id}))"
        )
    };
    let (server, local) = match mark {
        StampMark::Kept => return Ok(()),
        StampMark::Now => (
            next("?1"),
            next(&format!("'{LOCAL_NAMESPACE_PREFIX}' || ?1")),
        ),
        StampMark::At(mark) => (mark.server.to_string(), mark.local.to_string()),
    };
    conn.execute(
        &format!(
            "INSERT INTO note_file_marks (note_id, indexed_at, server_seq, local_seq)
             VALUES (?1, ?2, {server}, {local})
             ON CONFLICT(note_id) DO UPDATE SET indexed_at = excluded.indexed_at,
               server_seq = excluded.server_seq, local_seq = excluded.local_seq"
        ),
        params![note_id, indexed_at],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Drops the mark of a removed row.
pub(super) fn forget(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_file_marks WHERE note_id = ?1",
        params![note_id],
    )
    .map(|_| ())
    .map_err(failed)
}

/// The mark of the row's stamp, when one was recorded with it.
pub fn stamped_mark(conn: &Connection, note_id: &str) -> Result<Option<LogMark>, StorageError> {
    conn.query_row(
        "SELECT m.server_seq, m.local_seq FROM note_file_marks m
           JOIN note_files f ON f.note_id = m.note_id AND f.indexed_at = m.indexed_at
          WHERE m.note_id = ?1",
        params![note_id],
        |row| {
            Ok(LogMark {
                server: row.get(0)?,
                local: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// The SQL test, over a `note_files` row, that its mark names an entry of the note's body log or
/// snapshot stored after the stamp.
pub(super) fn moved_after_mark() -> String {
    let local = LOCAL_NAMESPACE_PREFIX;
    format!(
        "EXISTS (SELECT 1 FROM note_file_marks m
                  WHERE m.note_id = note_files.note_id AND m.indexed_at = note_files.indexed_at
                    AND (EXISTS (SELECT 1 FROM yjs_updates u
                                  WHERE u.doc_id = note_files.note_id AND u.seq >= m.server_seq)
                         OR EXISTS (SELECT 1 FROM yjs_updates u
                                     WHERE u.doc_id = '{local}' || note_files.note_id
                                       AND u.seq >= m.local_seq)
                         OR EXISTS (SELECT 1 FROM yjs_snapshots s
                                     WHERE s.doc_id = note_files.note_id
                                       AND s.last_seq >= m.server_seq)
                         OR EXISTS (SELECT 1 FROM yjs_snapshots s
                                     WHERE s.doc_id = '{local}' || note_files.note_id
                                       AND s.last_seq >= m.local_seq)))"
    )
}
