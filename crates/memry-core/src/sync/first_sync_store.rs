//! The durable half of the first sync: its two work lists and its two `meta`
//! keys (data-model §A.2).
//!
//! A separate module from [`super::first_sync`] because these four functions
//! are what make a killed run resumable, and they are worth reading without
//! the pass sequencing around them. Nothing here does I/O beyond one
//! statement; the ordering decisions are the caller's.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::crdt::update_log::Namespace;
use crate::storage::nested_tx;

use super::body_debt;
use super::body_pull::crdt_cursor_scope;
use super::pack_bootstrap::body_plan::{BodyCheck, current};
use super::store;

use super::first_sync::{META_FIRST_SYNC_BODY_PACKS, RECENT_BODY_LIMIT};

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

/// The background sweep (#3253): owes a body pull for every live note and
/// journal document outside `pulled`, so each later pass's body step fetches
/// them within its request budget. Desktop's paced catch-up queue is the
/// reference; opening a note still fetches it at once.
pub(super) fn owe_out_of_window(conn: &Connection, pulled: &[String]) -> Result<(), StorageError> {
    let live = live_document_ids(conn)?;
    let pulled: HashSet<&str> = pulled.iter().map(String::as_str).collect();
    // One transaction for the whole sweep (#5231): about 9,500 rows on a
    // large vault, and a failure part way owes none of them rather than some.
    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
    for id in live.iter().filter(|id| !pulled.contains(id.as_str())) {
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
/// `blobMissing` is not the write the row held either.
///
/// Only these keys are forgotten here, but the by-id pull that follows is
/// filtered by id alone on the server, so it answers, and applies without a
/// cursor, every type under the id. A row of another type sharing the id
/// therefore loses its cursor too. That costs one more pull of that row when
/// a killed run reconciles again, never a skipped one.
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

/// A document's `crdt:<docId>` cursor and stored server revision.
pub(super) type BodyState = (Option<i64>, Option<String>);

/// Each document's [`BodyState`], for the documents in `doc_ids` that hold
/// either half.
pub(super) fn body_states(
    conn: &Connection,
    doc_ids: &[String],
) -> Result<HashMap<String, BodyState>, StorageError> {
    let mut states = HashMap::new();
    for doc_id in doc_ids {
        let state = body_state(conn, doc_id)?;
        if state != (None, None) {
            states.insert(doc_id.clone(), state);
        }
    }
    Ok(states)
}

fn body_state(conn: &Connection, doc_id: &str) -> Result<BodyState, StorageError> {
    let cursor = store::read_cursor(conn, &crdt_cursor_scope(doc_id))?
        .and_then(|text| text.parse::<i64>().ok());
    let revision: Option<String> = conn
        .prepare_cached("SELECT server_revision FROM yjs_snapshots WHERE doc_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row(params![Namespace::Server.row_id(doc_id)], |row| row.get(0))
                .optional()
        })
        .map_err(sqlite_failed)?
        .flatten();
    Ok((cursor, revision))
}

/// The body pack phase's last step (chapter 08 §8.10, #5232), in one
/// transaction with its done mark: every live note and journal document is
/// settled or owed a route pull.
///
/// With a body manifest (`checks`), a listed document proven [`current`] is
/// settled. Every other document is owed, including one the manifest does not
/// list: its paging can skip a document created behind its cursor during the
/// read, and an absent document takes its baseline through the route
/// (§8.10). Without a manifest every document is owed: the batch route
/// answers no head. Answers `(settled, owed)`.
pub(super) fn settle_pack_bodies(
    conn: &Connection,
    checks: Option<&HashMap<String, BodyCheck>>,
) -> Result<(usize, usize), StorageError> {
    let live = live_document_ids(conn)?;
    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
    let (mut settled, mut owed) = (0, 0);
    for doc_id in &live {
        let (cursor, revision) = body_state(&txn, doc_id)?;
        let is_current = checks
            .and_then(|checks| checks.get(doc_id))
            .is_some_and(|check| current(check, cursor, revision.as_deref()));
        if is_current {
            body_debt::settle(&txn, doc_id)?;
            settled += 1;
        } else {
            body_debt::owe(&txn, doc_id)?;
            owed += 1;
        }
    }
    write_meta(&txn, META_FIRST_SYNC_BODY_PACKS, "1")?;
    txn.commit().map_err(sqlite_failed)?;
    Ok((settled, owed))
}

fn live_document_ids(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL
             UNION
             SELECT id FROM journal_entries WHERE deleted_at IS NULL",
        )
        .map_err(sqlite_failed)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::open_data;

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
    fn the_out_of_window_debts_land_all_or_none() {
        let dir = std::env::temp_dir().join(format!("memry-owe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        let db = open_data(&dir.join("data.db")).expect("open");
        db.call_blocking(|conn| {
            notes(conn, 100);
            conn.execute_batch(
                "CREATE TEMP TRIGGER refuse BEFORE INSERT ON meta WHEN NEW.key LIKE '%n0050'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END",
            )
            .expect("trigger");
            assert!(owe_out_of_window(conn, &["n0001".to_owned()]).is_err());
            assert_eq!(owed(conn), 0, "a failed sweep owes nothing");
            conn.execute_batch("DROP TRIGGER refuse").expect("drop");
            owe_out_of_window(conn, &["n0001".to_owned()])?;
            assert_eq!(owed(conn), 99, "every note outside the window is owed once");
            Ok(())
        })
        .expect("the sweep");
    }
}
