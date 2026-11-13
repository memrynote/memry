//! Data migration 0027, `desktop_record_types` (Step 16, #3533): kept apart from `tests.rs` for
//! its line ceiling.

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

/// A database the last build left steps forward with every `sync_items` row, including records
/// of the three types it could not read; a re-run after a crash before the `user_version` write
/// changes nothing; and the build before this one still opens the file.
#[test]
fn the_desktop_record_types_migration_keeps_rows_reruns_and_leaves_the_file_readable() {
    let db = Db::open_in_memory().expect("open");
    let before = 26;
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            r#"INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('note', 'n1', '{"title":"Plan"}', 'full', 1),
                        ('sticky_draft', 'd1', '{"content":"hi"}', 'full', 1),
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
            assert_eq!(migration.name, "desktop_record_types");
            conn.execute_batch(migration.sql).map_err(failed)?;
            Ok((
                count(conn, "SELECT COUNT(*) FROM sync_items")?,
                count(
                    conn,
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'
                     AND name IN ('canvas_folders', 'home_pages', 'sticky_drafts')",
                )?,
            ))
        })
        .expect("idempotent");
    assert_eq!((items, tables), (3, 3));

    let version = db
        .call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("an older build opens it");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
}
