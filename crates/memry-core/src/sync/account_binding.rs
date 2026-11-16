//! Which account a vault syncs with, and the sync state a sign-out ends (#3536 A4). Ported from
//! Electron's `sync/vault-account-binding.ts` and `sync/session-teardown.ts`.
//!
//! The binding is Electron's settings row `sync.account-binding.v1` (`{userId, mode}` JSON),
//! kept here as a `meta` key so it travels with the folder. Additive: an older build ignores the
//! key, and a vault written by one has none (unbound). The JSON is parsed by the desktop shell,
//! which owns the decision; this module stores the text as written.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;

use super::clock::OFFLINE_CLOCK_DEVICE_ID;
use super::first_sync_store::{read_meta, write_meta};
use super::pause::META_SYNC_PAUSED;

/// `VAULT_ACCOUNT_BINDING_SETTING` (`vault-account-binding.ts:39`).
pub const META_ACCOUNT_BINDING: &str = "sync.account-binding.v1";

pub fn read(conn: &Connection) -> Result<Option<String>, StorageError> {
    read_meta(conn, META_ACCOUNT_BINDING)
}

pub fn write(conn: &Connection, json: &str) -> Result<(), StorageError> {
    write_meta(conn, META_ACCOUNT_BINDING, json)
}

/// A task or an inbox item exists (`vaultHasLocalContent`'s database half; the shell checks the
/// folder for files).
pub fn has_local_rows(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM tasks) OR EXISTS (SELECT 1 FROM inbox_items)",
        [],
        |row| row.get::<_, bool>(0),
    )
    .map_err(failed)
}

/// A synced record carries a clock tick from a device other than `own` and the offline
/// placeholder (`vaultHasForeignHistory`): someone else's session wrote it.
pub fn has_foreign_history(conn: &Connection, own: &[String]) -> Result<bool, StorageError> {
    let own = serde_json::to_string(own).map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })?;
    conn.query_row(
        "SELECT 1 FROM sync_items s, json_each(s.clock) c
         WHERE s.clock IS NOT NULL AND json_valid(s.clock)
           AND c.key <> ?2 AND c.key NOT IN (SELECT value FROM json_each(?1))
         LIMIT 1",
        params![own, OFFLINE_CLOCK_DEVICE_ID],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(failed)
}

/// What a sign-out ends in the vault (`session-teardown.ts:104-111`), in one transaction: the
/// pass history and the persisted pause. The outbox is kept whole, note bodies and records
/// alike: Electron drops queued records because its next sign-in re-seeds every local record,
/// and this core has no re-seed, so a dropped row would never reach the server. Cursors and the
/// server vault id are kept: the account binding stops another account from syncing this vault.
pub fn clear_session_state(conn: &Connection) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    tx.execute("DELETE FROM sync_history", []).map_err(failed)?;
    tx.execute("DELETE FROM meta WHERE key = ?1", params![META_SYNC_PAUSED])
        .map_err(failed)?;
    tx.commit().map_err(failed)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    fn db() -> (crate::storage::test_support::TempDir, crate::storage::Db) {
        let dir = temp_dir("account-binding");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        (dir, db)
    }

    fn item(conn: &Connection, id: &str, clock: &str) {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload_state, clock, updated_at)
             VALUES ('task', ?1, 'full', ?2, 0)",
            params![id, clock],
        )
        .unwrap();
    }

    #[test]
    fn the_binding_round_trips_and_survives_a_reopen() {
        let dir = temp_dir("account-binding");
        let path = dir.path().join("data.db");
        let db = open_data(&path).unwrap();
        db.call_blocking(|conn| {
            assert_eq!(read(conn)?, None);
            write(conn, r#"{"userId":"u1","mode":"sync"}"#)
        })
        .unwrap();
        drop(db);
        let db = open_data(&path).unwrap();
        let json = db.call_blocking(|conn| read(conn)).unwrap();
        assert_eq!(json.as_deref(), Some(r#"{"userId":"u1","mode":"sync"}"#));
    }

    #[test]
    fn only_another_devices_tick_is_foreign_history() {
        let (_dir, db) = db();
        db.call_blocking(|conn| {
            let own = vec!["me-local".to_owned(), "me-server".to_owned()];
            assert!(!has_foreign_history(conn, &own)?);
            item(conn, "a", r#"{"me-local":3,"_offline":1}"#);
            item(conn, "b", r#"{"me-server":1}"#);
            assert!(!has_foreign_history(conn, &own)?, "own and offline ticks");
            item(conn, "c", r#"{"me-local":1,"other":2}"#);
            assert!(has_foreign_history(conn, &own)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_sign_out_clears_history_and_pause_and_keeps_the_outbox_and_the_server_vault() {
        let (_dir, db) = db();
        db.call_blocking(|conn| {
            conn.execute_batch(
                "INSERT INTO sync_history (id, kind, item_count, created_at) VALUES ('h1', 'push', 1, 1);
                 INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('task', 't', 'upsert', 1);
                 INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', 'n', 'crdt', 1);",
            )
            .unwrap();
            write_meta(conn, META_SYNC_PAUSED, "1")?;
            super::super::server_vault::bind(conn, "vault-1")?;
            write(conn, r#"{"userId":"u1","mode":"sync"}"#)?;
            clear_session_state(conn)?;
            let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(count("SELECT COUNT(*) FROM sync_history"), 0);
            assert_eq!(count("SELECT COUNT(*) FROM outbox"), 2, "every queued row stays");
            assert_eq!(read_meta(conn, META_SYNC_PAUSED)?, None);
            assert_eq!(super::super::server_vault::bound(conn)?.as_deref(), Some("vault-1"));
            assert!(read(conn)?.is_some(), "the binding stays with the folder");
            Ok(())
        })
        .unwrap();
    }
}
