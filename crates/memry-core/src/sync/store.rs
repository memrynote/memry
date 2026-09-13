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
             deleted_at = excluded.deleted_at",
        params![item_type, item_id, server_cursor, now_ms, deleted_at],
    )
    .map_err(failed)?;
    Ok(())
}

/// Applies an id from `deleted` that arrived with **no type on the wire**
/// (§5.12, §5.12.1).
///
/// Marks every existing row for that id deleted, whatever its type, and files
/// a bare tombstone when there is none. **Never an error and never a reason to
/// stop the page**: a delete is idempotent and a delete for an id this client
/// has never seen is a no-op that still has to be remembered.
///
/// A client MUST NOT try to infer the type from the id shape (§5.12.1):
/// `tag_definition` ids are tag names and `folder_config` ids are folder
/// paths, so id shapes are not disjoint across types.
pub fn apply_untyped_tombstone(
    conn: &Connection,
    item_id: &str,
    deleted_at: i64,
    now_ms: i64,
) -> Result<(), StorageError> {
    let touched = conn
        .execute(
            "UPDATE sync_items SET deleted_at = ?2, updated_at = ?3 WHERE item_id = ?1",
            params![item_id, deleted_at, now_ms],
        )
        .map_err(failed)?;
    if touched == 0 {
        mark_deleted(
            conn,
            BARE_TOMBSTONE_ITEM_TYPE,
            item_id,
            deleted_at,
            None,
            now_ms,
        )?;
    }
    Ok(())
}

/// Whether a bare tombstone was filed for this id (§5.12.1).
///
/// Consulted before an apply, because the tombstone that arrived without a
/// type has to outrank the typed item that arrives after it; otherwise the
/// "does not resurrect it locally" guarantee holds only until the next page.
pub fn has_bare_tombstone(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM sync_items
         WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NOT NULL",
        params![BARE_TOMBSTONE_ITEM_TYPE, item_id],
        |_| Ok(()),
    )
    .optional()
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

    #[test]
    fn an_untyped_tombstone_marks_every_row_for_that_id() {
        let (db, _dir) = open("sync-tombstone");
        db.call_blocking(|conn| {
            // §5.15's collision: a project and a tag can share the id `inbox`.
            mark_deleted(conn, "project", "inbox", 0, None, 1)?;
            conn.execute(
                "UPDATE sync_items SET deleted_at = NULL WHERE item_id = 'inbox'",
                [],
            )
            .map_err(failed)?;
            mark_deleted(conn, "tag_definition", "inbox", 0, None, 1)?;
            conn.execute(
                "UPDATE sync_items SET deleted_at = NULL WHERE item_id = 'inbox'",
                [],
            )
            .map_err(failed)?;

            apply_untyped_tombstone(conn, "inbox", 99, 100)?;
            let deleted: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sync_items WHERE item_id = 'inbox' AND deleted_at = 99",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            assert_eq!(deleted, 2);
            assert!(!has_bare_tombstone(conn, "inbox")?);
            Ok(())
        })
        .expect("tombstone");
    }

    #[test]
    fn an_unknown_id_gets_a_bare_tombstone_rather_than_an_error() {
        let (db, _dir) = open("sync-bare-tombstone");
        db.call_blocking(|conn| {
            apply_untyped_tombstone(conn, "never-seen", 99, 100)?;
            assert!(has_bare_tombstone(conn, "never-seen")?);
            Ok(())
        })
        .expect("bare tombstone");
    }
}
