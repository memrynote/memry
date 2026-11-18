//! Data migration `attachment_sync`: kept apart from `tests.rs` for its line ceiling.
//!
//! Each test finds the migration by name, so a renumbering after a clash
//! touches only the registry and the file name.

use rusqlite::Connection;

use super::*;
use crate::storage::test_support::temp_dir;
use crate::storage::{Db, open_data};
use crate::sync::attachments::store::{download_failures, files, releases, upload_queue};

const TABLES: [&str; 4] = [
    "attachment_download_failures",
    "attachment_files",
    "attachment_upload_queue",
    "deleted_asset_releases",
];

/// The index of `attachment_sync` in [`DATA_MIGRATIONS`]: the migrations before it are the
/// schema the build before this one wrote.
fn position() -> usize {
    DATA_MIGRATIONS
        .iter()
        .position(|migration| migration.name == "attachment_sync")
        .expect("attachment_sync is registered")
}

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// `(name, declared type, not null, default, primary key position)` of each column.
type Column = (String, String, bool, Option<String>, i64);

fn columns(conn: &Connection, table: &str) -> Result<Vec<Column>, StorageError> {
    let mut statement = conn
        .prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1)")
        .map_err(failed)?;
    statement
        .query_map([table], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn column(name: &str, kind: &str, not_null: bool, default: Option<&str>, pk: i64) -> Column {
    (
        name.into(),
        kind.into(),
        not_null,
        default.map(Into::into),
        pk,
    )
}

fn count(conn: &Connection, table: &str) -> Result<i64, StorageError> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .map_err(failed)
}

/// The columns, keys and indexes of Electron's tables (`packages/db-schema/src/schema/
/// attachment-*.ts`, `deleted-asset-releases.ts`), so the import copies rows unchanged.
#[test]
fn a_fresh_database_has_the_four_tables_in_electrons_shapes() {
    let db = Db::open_in_memory().expect("open");
    let version = db.call_blocking(run_data).expect("migrate");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    db.call_blocking(|conn| {
        assert_eq!(
            columns(conn, "attachment_upload_queue")?,
            [
                column("id", "TEXT", true, None, 1),
                column("note_id", "TEXT", true, None, 0),
                column("disk_path", "TEXT", true, None, 0),
                column("attempts", "INTEGER", true, Some("0"), 0),
                column("last_error", "TEXT", false, None, 0),
                column("created_at", "INTEGER", true, None, 0),
                column("updated_at", "INTEGER", true, None, 0),
            ]
        );
        assert_eq!(
            columns(conn, "attachment_download_failures")?,
            [
                column("id", "TEXT", true, None, 1),
                column("owner_id", "TEXT", true, None, 0),
                column("attachment_id", "TEXT", true, None, 0),
                column("reason", "TEXT", true, None, 0),
                column("attempts", "INTEGER", true, Some("0"), 0),
                column("last_error", "TEXT", false, None, 0),
                column("next_attempt_at", "INTEGER", false, None, 0),
                column("updated_at", "INTEGER", true, None, 0),
            ]
        );
        assert_eq!(
            columns(conn, "attachment_files")?,
            [
                column("note_id", "TEXT", true, None, 1),
                column("path", "TEXT", true, None, 2),
                column("attachment_id", "TEXT", false, None, 0),
                column("recorded_at", "INTEGER", true, None, 0),
            ]
        );
        assert_eq!(
            columns(conn, "deleted_asset_releases")?,
            [
                column("item_type", "TEXT", true, None, 1),
                column("item_id", "TEXT", true, None, 2),
                column("deleted_at", "INTEGER", true, None, 0),
                column("attachment_ids", "TEXT", false, None, 0),
            ]
        );
        let unique: bool = conn
            .query_row(
                "SELECT \"unique\" FROM pragma_index_list('attachment_upload_queue')
                 WHERE name = 'attachment_upload_queue_note_path'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)?;
        assert!(unique);
        let owner_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_index_list('attachment_download_failures')
                 WHERE name = 'idx_attachment_download_failures_owner'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)?;
        assert_eq!(owner_index, 1);
        Ok(())
    })
    .expect("shapes");
}

/// A `data.db` the current feat/tauri-v2 build left, with its rows, opens through the app's
/// own path and gains four empty tables. A crash between the commit and the `user_version`
/// write re-runs the migration over rows it already holds, which keeps them.
#[test]
fn a_database_of_the_previous_build_upgrades_keeps_its_rows_and_reruns_cleanly() {
    let dir = temp_dir("attachment-sync-upgrade");
    let path = dir.path().join("data.db");
    let before = position();
    {
        let db = Db::open(&path).expect("the previous build's file");
        db.call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..before])?;
            conn.execute_batch(
                "INSERT INTO note_body_sync (note_id, last_sent_at, updated_at) VALUES ('n1', 5, 5);
                 INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'a.md', 1);",
            )
            .map_err(failed)
        })
        .expect("a database as the previous build left it");
    }

    let db = open_data(&path).expect("this build opens it");
    db.call_blocking(|conn| {
        assert_eq!(user_version(conn)?, latest_version(DATA_MIGRATIONS));
        assert_eq!(count(conn, "note_body_sync")?, 1);
        assert_eq!(count(conn, "note_files")?, 1);
        for table in TABLES {
            assert_eq!(count(conn, table)?, 0, "{table}");
        }

        upload_queue::enqueue(conn, "n1", "/v/a.png", 1)?;
        files::record(conn, "n1", "attachments/n1/a.png", "att", 1)?;
        let migration = &DATA_MIGRATIONS[before];
        conn.execute_batch(migration.sql).map_err(failed)?;
        assert!(upload_queue::has_pending(conn, "n1", "/v/a.png")?);
        assert_eq!(
            files::path_of(conn, "n1", "att")?.as_deref(),
            Some("attachments/n1/a.png")
        );
        Ok(())
    })
    .expect("upgraded");
}

/// The build before this one opens the newer file: its runner applies nothing, fails
/// nothing, and its own tables read and write as before. The new rows wait for the next
/// upgrade untouched.
#[test]
fn an_older_build_opens_the_newer_database_and_leaves_the_new_rows_alone() {
    let dir = temp_dir("attachment-sync-downgrade");
    let path = dir.path().join("data.db");
    {
        let db = open_data(&path).expect("this build");
        db.call_blocking(|conn| {
            upload_queue::enqueue(conn, "n1", "/v/a.png", 1)?;
            download_failures::record_failure(
                conn,
                "n1",
                "a1",
                download_failures::FailureReason::Missing,
                "404",
                1,
            )?;
            files::count_known(conn, "n1", &[], 1)?;
            releases::record(conn, releases::ItemType::Canvas, "c1", None, 1)
        })
        .expect("rows of this build");
    }

    let older = Db::open(&path).expect("the older build's open");
    older
        .call_blocking(|conn| {
            let version = run(conn, &DATA_MIGRATIONS[..position()])?;
            assert_eq!(version, latest_version(DATA_MIGRATIONS), "nothing applied");
            conn.execute_batch(
                "INSERT INTO note_body_sync (note_id, updated_at) VALUES ('n2', 2);",
            )
            .map_err(failed)?;
            assert_eq!(count(conn, "note_body_sync")?, 1);
            for table in TABLES {
                assert_eq!(count(conn, table)?, 1, "{table}");
            }
            Ok(())
        })
        .expect("the older build reads its file");
}

/// Rows as Electron's drizzle writes them (`attachment-outbox.ts`, `attachment-files.ts`,
/// `attachment-download-state.ts`, `deleted-asset-release.ts`: JSON text for the id list)
/// read back through the stores unchanged.
#[test]
fn rows_in_electrons_encoding_read_through_the_stores() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| {
        run_data(conn)?;
        conn.execute_batch(
            "INSERT INTO attachment_upload_queue
               (id, note_id, disk_path, attempts, last_error, created_at, updated_at)
             VALUES ('6f1c2a7e-0d43-4b7a-9c55-0e7d1b6a2f10', 'n1', '/Vault/attachments/n1/a.png',
                     2, 'HTTP 503', 1700000000000, 1700000060000);
             INSERT INTO attachment_download_failures
               (id, owner_id, attachment_id, reason, attempts, last_error, next_attempt_at,
                updated_at)
             VALUES ('n1::att-1', 'n1', 'att-1', 'missing', 3, 'HTTP 404', NULL, 1700000000000);
             INSERT INTO attachment_files (note_id, path, attachment_id, recorded_at)
             VALUES ('n1', 'attachments/n1/a.png', 'att-1', 1700000000000),
                    ('n2', '', NULL, 1700000000000);
             INSERT INTO deleted_asset_releases (item_type, item_id, deleted_at, attachment_ids)
             VALUES ('note', 'n3', 1700000000000, '[\"att-2\",\"att-3\"]'),
                    ('canvas', 'c1', 1700000000000, NULL);",
        )
        .map_err(failed)?;

        let pending = upload_queue::list_pending(conn, 10)?;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 2);
        assert_eq!(
            pending[0].retry_opens_at(),
            1_700_000_060_000 + 2 * 60 * 1000
        );
        assert!(!download_failures::may_attempt(
            conn,
            "n1",
            "att-1",
            i64::MAX
        )?);
        let gone = download_failures::proven_gone(conn, "n1", &["att-1".to_owned()])?;
        assert!(gone.is_empty(), "n1 still owes the server an upload");
        upload_queue::clear(conn, "n1", "/Vault/attachments/n1/a.png")?;
        assert_eq!(
            download_failures::proven_gone(conn, "n1", &["att-1".to_owned()])?.len(),
            1
        );
        assert_eq!(
            files::path_of(conn, "n1", "att-1")?.as_deref(),
            Some("attachments/n1/a.png")
        );
        assert_eq!(files::records(conn, "n2")?[0].path, files::COUNTED_EMPTY);
        let due = releases::due(conn, 1_700_000_000_000)?;
        assert_eq!(
            due[1].attachment_ids,
            releases::RecordedIds::Ids(vec!["att-2".to_owned(), "att-3".to_owned()])
        );
        assert_eq!(due[0].attachment_ids, releases::RecordedIds::None);
        Ok(())
    })
    .expect("Electron rows");
}
