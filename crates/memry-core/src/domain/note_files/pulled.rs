//! The notes a pull changed whose file has not taken the pull yet (table `note_pulled_marks`,
//! migration 45): the desktop write-back's pulled place and frontmatter (#5309) survive a quit
//! between the pull and the note's pass. The sync observer records a mark ([`mark_pulled`]);
//! the pass reads it ([`pulled_mark`]), and deletes it once done ([`settle_pulled`]) unless a
//! pull came in meanwhile. A failed move counts ([`fail_pulled`]); the write-back's limit of
//! tries parks the mark, which the next pull resets.

use rusqlite::{Connection, OptionalExtension, params};

use super::failed;
use crate::api::errors::StorageError;

/// A pulled change the note's file has not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulledMark {
    /// The note's title before the first pull since its file was last placed; `None` when the
    /// note was not here.
    pub title_before: Option<String>,
    /// The passes whose move failed since the last pull.
    pub failed: u32,
    /// The pulls since the mark was made: [`settle_pulled`] deletes only the mark it read.
    pub pulls: i64,
}

/// Marks `note_id` pulled. A later pull keeps the first one's title (the file still carries
/// it) and resets the failed tries: the new pull is tried afresh.
pub fn mark_pulled(
    conn: &Connection,
    note_id: &str,
    title_before: Option<&str>,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO note_pulled_marks (note_id, title_before) VALUES (?1, ?2)
         ON CONFLICT(note_id) DO UPDATE SET pulls = pulls + 1, failed = 0",
        params![note_id, title_before],
    )
    .map(|_| ())
    .map_err(failed)
}

pub fn pulled_mark(conn: &Connection, note_id: &str) -> Result<Option<PulledMark>, StorageError> {
    conn.query_row(
        "SELECT title_before, failed, pulls FROM note_pulled_marks WHERE note_id = ?1",
        params![note_id],
        |row| {
            Ok(PulledMark {
                title_before: row.get(0)?,
                failed: row.get(1)?,
                pulls: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// The file took the pull `mark` was read at: the mark goes, unless a later pull came in.
pub fn settle_pulled(conn: &Connection, note_id: &str, pulls: i64) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_pulled_marks WHERE note_id = ?1 AND pulls = ?2",
        params![note_id, pulls],
    )
    .map(|_| ())
    .map_err(failed)
}

/// A pass's move failed: the failed tries, `None` when a later pull reset the mark.
pub fn fail_pulled(
    conn: &Connection,
    note_id: &str,
    pulls: i64,
) -> Result<Option<u32>, StorageError> {
    conn.query_row(
        "UPDATE note_pulled_marks SET failed = failed + 1 WHERE note_id = ?1 AND pulls = ?2
         RETURNING failed",
        params![note_id, pulls],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// Drops the mark whatever it holds: the note has no file to place, or its first file took the
/// record's place.
pub fn forget_pulled(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_pulled_marks WHERE note_id = ?1",
        params![note_id],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Every live note with a mark that failed fewer than `tries` passes, in id order: the open
/// reconcile schedules their passes.
pub fn pulled_notes(conn: &Connection, tries: u32) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT m.note_id FROM note_pulled_marks m
               JOIN notes ON notes.id = m.note_id AND notes.deleted_at IS NULL
              WHERE m.failed < ?1
              ORDER BY m.note_id",
        )
        .map_err(failed)?;
    statement
        .query_map(params![tries], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}
