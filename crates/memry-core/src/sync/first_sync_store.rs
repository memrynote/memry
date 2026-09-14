//! The durable half of the first sync: its two work lists and its two `meta`
//! keys (data-model §A.2).
//!
//! A separate module from [`super::first_sync`] because these four functions
//! are what make a killed run resumable, and they are worth reading without
//! the pass sequencing around them. Nothing here does I/O beyond one
//! statement; the ordering decisions are the caller's.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::first_sync::RECENT_BODY_LIMIT;

/// Pass two's work list: everything the refs pass recorded that still has no
/// payload, **newest first**.
///
/// This is the query data-model §A.2's partial index on
/// `payload_state = 'metadata-only'` exists for.
pub(super) fn pending_metadata_ids(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id FROM sync_items
             WHERE payload_state = 'metadata-only' AND deleted_at IS NULL
             ORDER BY updated_at DESC, item_id ASC",
        )
        .map_err(sqlite_failed)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_failed)?;
    Ok(ids)
}

/// Pass three's work list: the note and journal documents inside the window,
/// newest first, capped.
///
/// Read from the **projections**, not from `sync_items.updated_at`: the latter
/// is the instant this device applied the row, which pass two rewrites to
/// "now" for everything it touches, while `modified_at` is the payload's own
/// modification time and is what "recent" has to mean.
pub(super) fn recent_document_ids(
    conn: &Connection,
    window_start: i64,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM (
               SELECT id, COALESCE(modified_at, 0) AS m FROM notes WHERE deleted_at IS NULL
               UNION ALL
               SELECT id, COALESCE(modified_at, 0) AS m FROM journal_entries
                 WHERE deleted_at IS NULL
             )
             WHERE m >= ?1 ORDER BY m DESC LIMIT ?2",
        )
        .map_err(sqlite_failed)?;
    let ids = statement
        .query_map(params![window_start, RECENT_BODY_LIMIT as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sqlite_failed)?;
    Ok(ids)
}

pub fn read_meta(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(sqlite_failed)
}

pub(super) fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(sqlite_failed)?;
    Ok(())
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
