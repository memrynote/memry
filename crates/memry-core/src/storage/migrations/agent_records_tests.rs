//! Data migration 0029, `agent_records` (Step 16, #3533): kept apart from `tests.rs` for its
//! line ceiling.

use super::*;
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn count(conn: &Connection, sql: &str) -> Result<i64, StorageError> {
    conn.query_row(sql, [], |row| row.get(0)).map_err(failed)
}

/// A database the last build left steps forward with every `sync_items` row; a re-run after a
/// crash before the `user_version` write changes nothing; and the build before this one still
/// opens the file.
#[test]
fn the_agent_records_migration_keeps_rows_reruns_and_leaves_the_file_readable() {
    let db = Db::open_in_memory().expect("open");
    let before = 28;
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            r#"INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('note', 'n1', '{"title":"Plan"}', 'full', 1),
                        ('home_page', 'h1', '{"name":"Home"}', 'full', 1);"#,
        )
        .map_err(failed)
    })
    .expect("rows an older build wrote");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    let (items, tables) = db
        .call_blocking(|conn| {
            let migration = &DATA_MIGRATIONS[before];
            assert_eq!(migration.name, "agent_records");
            conn.execute_batch(migration.sql).map_err(failed)?;
            Ok((
                count(conn, "SELECT COUNT(*) FROM sync_items")?,
                count(
                    conn,
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'
                     AND name IN ('agent_conversations', 'agent_messages', 'agent_sealed_pending')",
                )?,
            ))
        })
        .expect("idempotent");
    assert_eq!((items, tables), (2, 3));

    let version = db
        .call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("an older build opens it");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
}
