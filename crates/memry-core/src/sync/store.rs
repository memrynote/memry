//! The two pieces of SQL the pull loop owns: the per-scope cursor and the
//! tombstone (chapter 05 §5.11, §5.12, data-model §A.2).
//!
//! Everything else the loop writes goes through
//! [`crate::storage::repositories`], which owns the verbatim-payload rule.
//! These two do not: a cursor is not an item, and a tombstone's body is
//! **never decoded** (§5.12), so there is no payload to store and
//! `apply_remote` has nothing to do.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;

use super::clock::{VectorClock, merge};

/// The one global record cursor (§5.11). `crdt:<docId>` is the other scope
/// this table carries; per-**type** cursors are forbidden — the feed is one
/// ordered stream.
pub const RECORD_CURSOR_SCOPE: &str = "record";

/// The `item_type` a bare tombstone is filed under.
///
/// §5.12 says an id in `deleted` with no ref row has **no type on the wire**
/// and that a conforming client records a bare tombstone for it, so that a
/// later pull of the same id does not resurrect it. §5.15 says the bookkeeping
/// key is `(type, id)` and never `id` alone. The chapter does not reconcile
/// the two, so this constant is the core's answer: a sentinel type that cannot
/// collide with any of the twenty-six `SYNC_ITEM_TYPES`, queried by id alone
/// before an apply. Recorded as a specification gap rather than inferred from
/// desktop.
pub const BARE_TOMBSTONE_ITEM_TYPE: &str = "_tombstone";

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Reads a scope's cursor, or `None` when this device has never synced it.
pub fn read_cursor(conn: &Connection, scope: &str) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT cursor FROM sync_cursors WHERE scope = ?1",
        params![scope],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(failed)
    .map(Option::flatten)
}

/// Advances a scope's cursor.
///
/// **Only ever called after the page's items were applied** (§5.11). The call
/// site is the enforcement; this function cannot tell.
pub fn write_cursor(
    conn: &Connection,
    scope: &str,
    cursor: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_cursors (scope, cursor, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor,
                                          updated_at = excluded.updated_at",
        params![scope, cursor, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// Marks one `(type, id)` deleted without touching its payload.
///
/// §5.12: a tombstone arrives as a full signed item and a set `deletedAt` is
/// the delete signal; the body is never decoded, so the bytes already in the
/// column stay exactly as they were. The row is inserted when it is absent,
/// because a delete for an item this device never pulled must still be
/// recorded or the next pull of that id resurrects it.
pub fn mark_deleted(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
    server_cursor: Option<i64>,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, server_cursor,
             updated_at, deleted_at
         ) VALUES (?1, ?2, NULL, 'metadata-only', ?3, ?4, ?5)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             server_cursor = COALESCE(excluded.server_cursor, sync_items.server_cursor),
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             corrupt_reason = NULL,
             corrupt_at = NULL",
        params![item_type, item_id, server_cursor, now_ms, deleted_at],
    )
    .map_err(failed)?;
    super::delete_wins::forget(conn, item_type, item_id)
}

/// Remembers a delete clock for `(type, id)`, merged into what is already
/// there, so the store only ever grows (#2409).
///
/// The one thing a re-create of the id reads ([`tombstone_clock`]): a create
/// over a tombstone must happen strictly after it or the server refuses it
/// (chapter 05 §5.8). An empty clock carries nothing and is not stored.
pub fn record_tombstone_clock(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    clock: &VectorClock,
    now_ms: i64,
) -> Result<(), StorageError> {
    if clock.is_empty() {
        return Ok(());
    }
    let merged = match tombstone_clock(conn, item_type, item_id)? {
        Some(stored) => merge(&stored, clock),
        None => clock.clone(),
    };
    let text = serde_json::to_string(&merged).map_err(|error| StorageError::Failed {
        what: format!("tombstone clock will not serialise: {error}"),
    })?;
    conn.execute(
        "INSERT INTO sync_tombstone_clocks (item_type, item_id, clock, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             clock = excluded.clock,
             updated_at = excluded.updated_at",
        params![item_type, item_id, text, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// The highest delete clock recorded for `(type, id)`, or `None` when this
/// device never saw one (a delete from before #2409 included).
///
/// A stored clock that does not parse is a **hard error**: reading it as
/// absent would mint a re-create the tombstone dominates.
pub fn tombstone_clock(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<VectorClock>, StorageError> {
    let text = conn
        .query_row(
            "SELECT clock FROM sync_tombstone_clocks WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(failed)?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|error| StorageError::Failed {
            what: format!("stored tombstone clock is not a vector clock: {error}"),
        })
    })
    .transpose()
}

/// Whether an older build filed a bare tombstone for this id (§5.12.2).
///
/// Consulted before an apply, because the tombstone that arrived without a
/// type has to outrank the typed item that arrives after it; otherwise the
/// "does not resurrect it locally" guarantee holds only until the next page.
/// No current path files one (§5.12.1, #5340); the rows already on disk stay.
pub fn has_bare_tombstone(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    conn.prepare_cached(
        "SELECT 1 FROM sync_items
         WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NOT NULL",
    )
    .and_then(|mut statement| {
        statement
            .query_row(params![BARE_TOMBSTONE_ITEM_TYPE, item_id], |_| Ok(()))
            .optional()
    })
    .map_err(failed)
    .map(|found| found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, open_data, test_support::temp_dir};

    fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        (db, dir)
    }

    #[test]
    fn the_cursor_is_per_scope_and_starts_absent() {
        let (db, _dir) = open("sync-cursor");
        db.call_blocking(|conn| {
            assert_eq!(read_cursor(conn, RECORD_CURSOR_SCOPE)?, None);
            write_cursor(conn, RECORD_CURSOR_SCOPE, Some("42"), 1)?;
            write_cursor(conn, "crdt:note-1", Some("7"), 1)?;
            assert_eq!(
                read_cursor(conn, RECORD_CURSOR_SCOPE)?,
                Some("42".to_owned())
            );
            assert_eq!(read_cursor(conn, "crdt:note-1")?, Some("7".to_owned()));
            Ok(())
        })
        .expect("cursors");
    }
}
