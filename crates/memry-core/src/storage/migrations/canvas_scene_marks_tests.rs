//! Data migration 0037, `canvas_scene_marks`: kept apart from `tests.rs` for its line ceiling.

use super::*;
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn position() -> usize {
    DATA_MIGRATIONS
        .iter()
        .position(|migration| migration.name == "canvas_scene_marks")
        .expect("the canvas_scene_marks migration")
}

fn marks(conn: &rusqlite::Connection) -> Result<i64, StorageError> {
    conn.query_row("SELECT COUNT(*) FROM canvas_scene_marks", [], |row| {
        row.get(0)
    })
    .map_err(failed)
}

/// A fresh database has the table, empty.
#[test]
fn a_fresh_database_has_no_marks() {
    let db = Db::open_in_memory().expect("open");
    let count = db
        .call_blocking(|conn| {
            run(conn, DATA_MIGRATIONS)?;
            marks(conn)
        })
        .expect("migrate");
    assert_eq!(count, 0);
}

/// A database the last build left steps forward with its `canvas_files` rows untouched and no
/// mark (their record side reads as unknown); a re-run after a crash before the `user_version`
/// write keeps the marks; and the build before this one still opens the file.
#[test]
fn the_marks_migration_keeps_rows_reruns_and_leaves_the_file_readable_to_older_builds() {
    let db = Db::open_in_memory().expect("open");
    let before = position();
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO canvas_files (canvas_id, file_path, scene_sha256, written_at)
             VALUES ('c1', 'canvases/Plan.excalidraw', 'aa', 100)",
            [],
        )
        .map(drop)
        .map_err(failed)
    })
    .expect("a row the last build wrote");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    let (row, count) = db
        .call_blocking(|conn| {
            let row: (String, String) = conn
                .query_row(
                    "SELECT file_path, scene_sha256 FROM canvas_files WHERE canvas_id = 'c1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(failed)?;
            conn.execute(
                "INSERT INTO canvas_scene_marks (canvas_id, file_sha256, record_sha256)
                 VALUES ('c1', 'aa', 'bb')",
                [],
            )
            .map_err(failed)?;
            conn.execute_batch(DATA_MIGRATIONS[before].sql)
                .map_err(failed)?;
            Ok((row, marks(conn)?))
        })
        .expect("idempotent");
    assert_eq!(
        row,
        ("canvases/Plan.excalidraw".to_owned(), "aa".to_owned())
    );
    assert_eq!(count, 1, "the re-run keeps the mark");

    let version = db
        .call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("an older build opens it");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
}
