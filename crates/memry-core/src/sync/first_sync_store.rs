//! The durable half of the first sync: its two work lists and its two `meta`
//! keys (data-model §A.2).
//!
//! A separate module from [`super::first_sync`] because these four functions
//! are what make a killed run resumable, and they are worth reading without
//! the pass sequencing around them. Nothing here does I/O beyond one
//! statement; the ordering decisions are the caller's.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::body_debt;

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
/// newest first, capped at `limit` (`None`: every one).
///
/// Read from the **projections**, not from `sync_items.updated_at`: the latter
/// is the instant this device applied the row, which pass two rewrites to
/// "now" for everything it touches, while `modified_at` is the payload's own
/// modification time and is what "recent" has to mean.
pub(super) fn recent_document_ids(
    conn: &Connection,
    window_start: i64,
    limit: Option<usize>,
) -> Result<Vec<String>, StorageError> {
    // SQLite reads a negative `LIMIT` as none.
    let limit = limit.map_or(-1, |limit| i64::try_from(limit).unwrap_or(i64::MAX));
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
        .query_map(params![window_start, limit], |row| row.get::<_, String>(0))
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sqlite_failed)?;
    Ok(ids)
}

/// The background sweep (#3253): owes a body pull for every live note and
/// journal document, so each later pass's body step fetches the ones the
/// bodies pass did not merge within its request budget. Desktop's paced
/// catch-up queue is the reference; opening a note still fetches it at once.
pub(super) fn owe_live_documents(conn: &Connection) -> Result<(), StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL
             UNION
             SELECT id FROM journal_entries WHERE deleted_at IS NULL",
        )
        .map_err(sqlite_failed)?;
    let live = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sqlite_failed)?;
    // One transaction: one commit for a vault of ten thousand notes, not one each.
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    for id in &live {
        body_debt::owe(&txn, id)?;
    }
    txn.commit().map_err(sqlite_failed)
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

pub(crate) fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    /// Desktop's first sync passes no cap: past [`super::super::first_sync::RECENT_BODY_LIMIT`],
    /// every live document is in the bodies pass's work list, newest first.
    #[test]
    fn no_limit_lists_every_live_document_past_the_phone_cap() {
        let dir = temp_dir("first-sync-no-limit");
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        let ids = db
            .call_blocking(|conn| {
                for n in 0..601i64 {
                    conn.execute(
                        "INSERT INTO notes (id, title, modified_at) VALUES (?1, 't', ?2)",
                        params![format!("note{n:08}"), n],
                    )
                    .map_err(sqlite_failed)?;
                }
                let capped = recent_document_ids(conn, i64::MIN, Some(500))?;
                assert_eq!(capped.len(), 500);
                recent_document_ids(conn, i64::MIN, None)
            })
            .unwrap();
        assert_eq!(ids.len(), 601);
        assert_eq!(ids[0], "note00000600");
    }
}
