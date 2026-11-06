//! Data migration 0021, `note_large_files`: kept apart from `tests.rs` for its line ceiling.

use super::*;
use crate::domain::note_files;
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// A database the last build left steps forward with its rows, a re-run after a crash before
/// the `user_version` write succeeds, and the build before this one still reads the file.
#[test]
fn the_large_files_migration_keeps_rows_reruns_and_leaves_the_file_readable_to_older_builds() {
    let db = Db::open_in_memory().expect("open");
    let before = latest_version(DATA_MIGRATIONS) as usize - 1;
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'big.md', 1);",
        )
        .map_err(failed)
    })
    .expect("a row to keep");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    let large = db
        .call_blocking(|conn| {
            assert!(
                !note_files::is_large_file(conn, "n1")?,
                "nothing measured yet"
            );
            note_files::set_large_file(conn, "n1", true)?;
            let migration = DATA_MIGRATIONS.last().expect("this migration");
            assert_eq!(migration.name, "note_large_files");
            conn.execute_batch(migration.sql).map_err(failed)?;
            note_files::is_large_file(conn, "n1")
        })
        .expect("idempotent");
    assert!(large, "the re-run keeps the class");

    let (version, path) = db
        .call_blocking(|conn| {
            let version = run(conn, &DATA_MIGRATIONS[..before])?;
            let row = note_files::by_id(conn, "n1")?.expect("the row");
            Ok((version, row.path))
        })
        .expect("an older build opens it");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    assert_eq!(path, "big.md");
}

/// The class is file state of the note: it goes with the note's row, so a day file that comes
/// back under the same id starts unmeasured.
#[test]
fn a_removed_row_takes_its_class_with_it() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    let large = db
        .call_blocking(|conn| {
            conn.execute_batch(
                "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('j1', 'day.md', 1);",
            )
            .map_err(failed)?;
            note_files::set_large_file(conn, "j1", true)?;
            note_files::remove(conn, "j1")?;
            note_files::is_large_file(conn, "j1")
        })
        .expect("remove");
    assert!(!large);
}
