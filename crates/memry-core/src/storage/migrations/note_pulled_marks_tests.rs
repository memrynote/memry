//! Data migration 0045, `note_pulled_marks`, and the marks over it (`note_files::pulled`), on a
//! real SQLite database.

use super::*;
use crate::domain::note_files::{self, PulledMark};
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn exec(db: &Db, sql: &'static str) {
    db.call_blocking(move |conn| conn.execute_batch(sql).map_err(failed))
        .expect(sql);
}

fn mark(db: &Db) -> Option<PulledMark> {
    db.read_blocking(|conn| note_files::pulled_mark(conn, "n1"))
        .unwrap()
}

/// A database the build before left steps forward with its rows, a re-run after a crash before
/// the `user_version` write keeps the marks, and the build before reads the file as it did.
#[test]
fn the_pulled_marks_migration_keeps_rows_reruns_and_leaves_the_file_readable() {
    let db = Db::open_in_memory().expect("open");
    let at = DATA_MIGRATIONS
        .iter()
        .position(|m| m.name == "note_pulled_marks")
        .expect("the migration");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..at]))
        .expect("a database as the build before left it");
    exec(
        &db,
        "INSERT INTO notes (id, title) VALUES ('n1', 'n');
         INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'n.md', 1);",
    );
    assert_eq!(
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS)).unwrap(),
        latest_version(DATA_MIGRATIONS)
    );
    db.call_blocking(|conn| note_files::mark_pulled(conn, "n1", Some("n")))
        .unwrap();
    // A crash between the commit and the `user_version` write runs the SQL again.
    exec(&db, DATA_MIGRATIONS[at].sql);
    assert_eq!(
        mark(&db),
        Some(PulledMark {
            title_before: Some("n".into()),
            failed: 0,
            pulls: 1,
        })
    );
    let older = db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT path FROM note_files WHERE note_id = 'n1'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map_err(failed)
        })
        .unwrap();
    assert_eq!(older, "n.md");
}

/// A later pull keeps the first title and resets the tries; a pass settles only the pull it
/// read; a mark at the tries is not listed; a removed row takes its mark.
#[test]
fn a_mark_keeps_the_first_title_and_settles_only_what_its_pass_read() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS)).unwrap();
    exec(
        &db,
        "INSERT INTO notes (id, title) VALUES ('n1', 'Plan');
         INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'n.md', 1);",
    );
    let listed = |db: &Db| {
        db.read_blocking(|conn| note_files::pulled_notes(conn, 2))
            .unwrap()
    };
    db.call_blocking(|conn| {
        note_files::mark_pulled(conn, "n1", Some("n"))?;
        assert_eq!(note_files::fail_pulled(conn, "n1", 1)?, Some(1));
        assert_eq!(note_files::fail_pulled(conn, "n1", 7)?, None);
        note_files::mark_pulled(conn, "n1", Some("Plan"))
    })
    .unwrap();
    let read = mark(&db).expect("a mark");
    assert_eq!(read.title_before.as_deref(), Some("n"));
    assert_eq!((read.failed, read.pulls), (0, 2));

    db.call_blocking(|conn| note_files::settle_pulled(conn, "n1", 1))
        .unwrap();
    assert!(mark(&db).is_some(), "a pull came in after the read");
    db.call_blocking(|conn| {
        note_files::fail_pulled(conn, "n1", 2)?;
        note_files::fail_pulled(conn, "n1", 2)
    })
    .unwrap();
    assert!(listed(&db).is_empty(), "the tries are spent");
    db.call_blocking(|conn| note_files::settle_pulled(conn, "n1", 2))
        .unwrap();
    assert_eq!(mark(&db), None);

    db.call_blocking(|conn| note_files::mark_pulled(conn, "n1", None))
        .unwrap();
    assert_eq!(listed(&db), ["n1"]);
    db.call_blocking(|conn| note_files::remove(conn, "n1"))
        .unwrap();
    assert_eq!(mark(&db), None);
}
