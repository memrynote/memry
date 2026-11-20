//! The durable half of the first sync: its two work lists and its two `meta`
//! keys (data-model §A.2).
//!
//! A separate module from [`super::first_sync`] because these four functions
//! are what make a killed run resumable, and they are worth reading without
//! the pass sequencing around them. Nothing here does I/O beyond one
//! statement; the ordering decisions are the caller's.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::storage::nested_tx;

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

/// Whether pass two left a row it can still fill: `metadata-only`, live, and not
/// held corrupt or refused (`corrupt_reason`), which a re-read would not fix.
pub(super) fn metadata_left_behind(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_items
                        WHERE payload_state = 'metadata-only' AND deleted_at IS NULL
                          AND corrupt_reason IS NULL)",
        [],
        |row| row.get(0),
    )
    .map_err(sqlite_failed)
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
    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
    for id in &live {
        body_debt::owe(&txn, id)?;
    }
    txn.commit().map_err(sqlite_failed)
}

/// Records one refs-pass row (chapter 05 §5.11.1).
///
/// A row this device already holds keeps its `server_cursor`: that cursor
/// names the write the row holds, taken from a record pack entry, and the
/// manifest reconcile compares it (chapter 08 §8.10). A ref names an item,
/// not a write, so it can neither confirm nor replace that cursor; a newer
/// write shows as a cursor mismatch and is pulled.
pub(super) fn record_ref(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    modified_at: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, server_cursor, updated_at
         ) VALUES (?1, ?2, NULL, 'metadata-only', NULL, ?3)
         ON CONFLICT(item_type, item_id) DO UPDATE SET updated_at = excluded.updated_at",
        params![item_type, item_id, modified_at],
    )
    .map_err(sqlite_failed)?;
    Ok(())
}

/// One local `sync_items` row as the manifest reconcile sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HeldRow {
    pub(super) item_type: String,
    pub(super) item_id: String,
    pub(super) server_cursor: Option<i64>,
    /// Live and carrying a payload.
    pub(super) held: bool,
    /// An outbox entry names it: the device changed it locally.
    pub(super) local_change: bool,
}

pub(super) fn held_rows(conn: &Connection) -> Result<Vec<HeldRow>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT s.item_type, s.item_id, s.server_cursor,
                    s.deleted_at IS NULL AND s.payload_state <> 'metadata-only',
                    EXISTS (SELECT 1 FROM outbox o
                            WHERE o.item_type = s.item_type AND o.item_id = s.item_id)
             FROM sync_items s",
        )
        .map_err(sqlite_failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(HeldRow {
                item_type: row.get(0)?,
                item_id: row.get(1)?,
                server_cursor: row.get(2)?,
                held: row.get(3)?,
                local_change: row.get(4)?,
            })
        })
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_failed)?;
    Ok(rows)
}

/// Forgets the cursor of these `(type, id)` rows before they are pulled by
/// id: `POST /sync/pull` names no cursor, and an item it reports in
/// `blobMissing` is not the write the row held either. A row of another type
/// under the same id keeps its cursor.
pub(super) fn forget_cursors(
    conn: &Connection,
    keys: &[(String, String)],
) -> Result<(), StorageError> {
    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
    for (item_type, item_id) in keys {
        txn.execute(
            "UPDATE sync_items SET server_cursor = NULL WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
        )
        .map_err(sqlite_failed)?;
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

    fn notes(conn: &Connection, count: usize) {
        for index in 0..count {
            conn.execute(
                "INSERT INTO notes (id, title) VALUES (?1, 't')",
                params![format!("n{index:04}")],
            )
            .expect("a note");
        }
    }

    fn owed(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM meta WHERE key LIKE '%n0%'",
            [],
            |row| row.get(0),
        )
        .expect("count")
    }

    /// #5231: the sweep's debts land in one transaction, so a failure part way
    /// leaves none rather than some, and the next pass owes them all again.
    #[test]
    fn the_live_document_debts_land_all_or_none() {
        let dir = temp_dir("owe-live");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|conn| {
            notes(conn, 100);
            conn.execute_batch(
                "CREATE TEMP TRIGGER refuse BEFORE INSERT ON meta WHEN NEW.key LIKE '%n0050'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END",
            )
            .expect("trigger");
            assert!(owe_live_documents(conn).is_err());
            assert_eq!(owed(conn), 0, "a failed sweep owes nothing");
            conn.execute_batch("DROP TRIGGER refuse").expect("drop");
            owe_live_documents(conn)?;
            assert_eq!(owed(conn), 100, "every live note is owed once");
            Ok(())
        })
        .expect("the sweep");
    }
}
