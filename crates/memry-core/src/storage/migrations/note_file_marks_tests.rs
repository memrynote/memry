//! Data migration 0027, `note_file_marks`: kept apart from `tests.rs` for its line ceiling.

use super::*;
use crate::domain::note_files::{self, NoteFileStat};
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn stat(note_id: &str, indexed_at: i64) -> NoteFileStat {
    NoteFileStat {
        note_id: note_id.to_owned(),
        path: format!("{note_id}.md"),
        file_type: "markdown".to_owned(),
        mime_type: None,
        file_size: Some(1),
        content_hash: None,
        file_hash: None,
        indexed_at,
    }
}

/// A database the last build left steps forward with its rows, which carry no mark and are read
/// by the clock as before; a re-run after a crash before the `user_version` write keeps the
/// marks; and the build before this one still reads the file.
#[test]
fn the_marks_migration_keeps_rows_reruns_and_leaves_the_file_readable_to_older_builds() {
    let db = Db::open_in_memory().expect("open");
    // Migration 27: the builds before it ran the first 26.
    let before = 26;
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('old', 'old.md', 100);
             INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at)
               VALUES ('local.old', 1, x'00', 100);",
        )
        .map_err(failed)
    })
    .expect("a row an older build stamped");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    let marked = db
        .call_blocking(|conn| {
            assert!(
                !note_files::behind_body(conn, "old")?,
                "an unmarked row is read by its clock"
            );
            note_files::upsert_stats(conn, &[stat("new", 100)])?;
            let migration = &DATA_MIGRATIONS[before];
            assert_eq!(migration.name, "note_file_marks");
            conn.execute_batch(migration.sql).map_err(failed)?;
            note_files::stamped_mark(conn, "new")
        })
        .expect("idempotent");
    assert!(marked.is_some(), "the re-run keeps the mark");

    let (version, path) = db
        .call_blocking(|conn| {
            let version = run(conn, &DATA_MIGRATIONS[..before])?;
            let row = note_files::by_id(conn, "new")?.expect("the row");
            Ok((version, row.path))
        })
        .expect("an older build opens it");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    assert_eq!(path, "new.md");
}

/// The mark goes with the note's row.
#[test]
fn a_removed_row_takes_its_mark_with_it() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    let left = db
        .call_blocking(|conn| {
            note_files::upsert_stats(conn, &[stat("n1", 100)])?;
            note_files::remove(conn, "n1")?;
            conn.query_row("SELECT COUNT(*) FROM note_file_marks", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(failed)
        })
        .expect("remove");
    assert_eq!(left, 0);
}

/// The open marks a markdown row an older build stamped (no mark, or a mark of an earlier stamp)
/// while its body is not ahead of it by the clock, at the log as it is; a row whose body is ahead
/// stays unmarked, and so does a row whose body took typing in its stamp's millisecond, which may
/// have come after the stamp; a marked row keeps its mark.
#[test]
fn the_open_marks_only_the_unmarked_rows_whose_body_is_not_ahead() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    let marks = db
        .call_blocking(|conn| {
            note_files::upsert_stats(conn, &[stat("kept", 100)])?;
            conn.execute_batch(
                "INSERT INTO note_files (note_id, path, file_type, indexed_at) VALUES
                   ('old', 'old.md', 'markdown', 100),
                   ('moved', 'moved.md', 'markdown', 100),
                   ('restamped', 'restamped.md', 'markdown', 100),
                   ('same', 'same.md', 'markdown', 100),
                   ('image', 'image.png', 'image', 100);
                 INSERT INTO note_file_marks VALUES ('restamped', 90, 7, 7);
                 INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES
                   ('local.old', 4, x'00', 99),
                   ('local.same', 1, x'00', 100),
                   ('old', 2, x'00', 99),
                   ('local.moved', 1, x'00', 101),
                   ('local.kept', 1, x'00', 100);",
            )
            .map_err(failed)?;
            let kept = note_files::stamped_mark(conn, "kept")?;
            assert_eq!(note_files::mark_unmarked(conn)?, 2);
            assert_eq!(
                note_files::stamped_mark(conn, "kept")?,
                kept,
                "a mark is kept"
            );
            ["old", "restamped", "moved", "same", "image"]
                .iter()
                .map(|id| note_files::stamped_mark(conn, id))
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("mark");
    let at = |server, local| Some(note_files::LogMark { server, local });
    assert_eq!(marks, [at(3, 5), at(1, 1), None, None, None]);
}
