//! A folder the desktop app deletes, against real SQLite (Step 13h, #3530): recorded first,
//! then every note, row, folder record and the manual order in one transaction.
//!
//! | Test                                                          | Rule                              |
//! | ------------------------------------------------------------- | --------------------------------- |
//! | a folder delete tombstones its notes, rows, records and order | `deleteFolderCommand`, one step   |
//! | a local-only note in a deleted folder sends no tombstone      | local-only, Step 13f              |
//! | a folder's delete is recorded once, and only it forgets it    | `notes.folder_delete.v1`, compat  |
//! | a folder no record can name is deleted with its notes         | a folder made in a file manager   |
//! | a folder holding what no note delete takes is refused unrecorded | nothing goes half              |
//! | a record another build wrote is reported and kept             | `notes.folder_delete.v1`, compat  |

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::folders;
use memry_core::domain::note_files;
use memry_core::domain::notes::app_move::BeginError;
use memry_core::domain::notes::folder_delete::{self, FolderDeleteRecorded};
use memry_core::domain::notes::local_only;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, give_row, open, outbox, place, position, run,
};

fn row_path(db: &memry_core::storage::Db, id: &str) -> Option<String> {
    run(db, |conn| note_files::by_id(conn, id)).map(|row| row.path)
}

fn live(db: &memry_core::storage::Db, sql: &'static str) -> Vec<String> {
    run(db, |conn| {
        let mut statement = conn.prepare(sql).unwrap();
        let rows = statement.query_map([], |row| row.get(0)).unwrap();
        Ok(rows.map(Result::unwrap).collect())
    })
}

fn live_notes(db: &memry_core::storage::Db) -> Vec<String> {
    live(
        db,
        "SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY id",
    )
}

fn live_folders(db: &memry_core::storage::Db) -> Vec<String> {
    live(
        db,
        "SELECT path FROM folders WHERE deleted_at IS NULL ORDER BY path",
    )
}

fn pending(db: &memry_core::storage::Db) -> Vec<FolderDeleteRecorded> {
    run(db, |conn| folder_delete::pending(conn))
}

/// `Work` holding `Plan.md` and `Sub/Deep.md`, both folders recorded, `Keep.md` beside it,
/// and the root and `Work` ordered by hand.
fn work(label: &str) -> memry_core::storage::Db {
    let db = open(label);
    create(&db, "n1", "Plan", Some("Work"));
    create(&db, "n2", "Deep", Some("Work/Sub"));
    create(&db, "n3", "Keep", None);
    give_row(&db, "n1", "Work/Plan.md");
    give_row(&db, "n2", "Work/Sub/Deep.md");
    give_row(&db, "n3", "Keep.md");
    run(&db, |conn| {
        folders::create(conn, "Work", Some("book"), DEVICE, NOW)?.acknowledge();
        folders::create(conn, "Work/Sub", None, DEVICE, NOW)?.acknowledge();
        Ok(())
    });
    place(&db, "", &["Keep.md", "Work"]);
    place(&db, "Work", &["Work/Sub", "Work/Plan.md"]);
    clear_outbox(&db);
    db
}

#[test]
fn a_folder_delete_tombstones_its_notes_rows_records_and_order() {
    let db = work("folder-delete");
    run(&db, |conn| {
        Ok(folder_delete::begin(conn, "Work", &["n1", "n2"]))
    })
    .unwrap();
    assert_eq!(pending(&db), [FolderDeleteRecorded::Delete("Work".into())]);

    run(&db, |conn| {
        folder_delete::deleted_by_app(conn, "Work", &["n1", "n2"], DEVICE, NOW + 1)
    });

    assert_eq!(live_notes(&db), ["n3"]);
    assert_eq!(row_path(&db, "n1"), None);
    assert_eq!(row_path(&db, "n2"), None);
    assert_eq!(row_path(&db, "n3").as_deref(), Some("Keep.md"));
    assert_eq!(live_folders(&db), Vec::<String>::new());
    let mut pushed = outbox(&db);
    pushed.sort();
    let expected = [
        ("delete", "Work"),
        ("delete", "Work/Sub"),
        ("delete", "n1"),
        ("delete", "n2"),
    ]
    .map(|(op, id)| (op.to_owned(), id.to_owned()));
    assert_eq!(pushed, expected);
    assert_eq!(position(&db, "Work"), None);
    assert_eq!(position(&db, "Work/Plan.md"), None);
    assert_eq!(position(&db, "Keep.md"), Some((String::new(), 0)));
    assert_eq!(pending(&db), []);
}

#[test]
fn a_local_only_note_in_a_deleted_folder_sends_no_tombstone() {
    let db = work("folder-delete-local-only");
    db.call_blocking(|conn| local_only::set(conn, "n1", true, NOW + 1))
        .unwrap();
    clear_outbox(&db);
    run(&db, |conn| {
        folder_delete::deleted_by_app(conn, "Work", &["n1", "n2"], DEVICE, NOW + 2)
    });
    assert_eq!(live_notes(&db), ["n3"]);
    let ids: Vec<String> = outbox(&db).into_iter().map(|(_, id)| id).collect();
    assert!(!ids.contains(&"n1".to_owned()), "{ids:?}");
    assert!(ids.contains(&"n2".to_owned()), "{ids:?}");
}

/// The record sits under its own key, which no older build reads; a folder recorded once
/// holds its next delete back until the open settles it.
#[test]
fn a_folders_delete_is_recorded_once_and_only_it_forgets_it() {
    let db = work("folder-delete-record");
    run(&db, |conn| {
        Ok(folder_delete::begin(conn, "Work", &["n1", "n2"]))
    })
    .unwrap();
    let keys = live(
        &db,
        "SELECT key FROM meta WHERE key LIKE 'notes.folder_delete%'",
    );
    assert_eq!(keys, ["notes.folder_delete.v1:Work"]);
    let again = run(&db, |conn| {
        Ok(folder_delete::begin(conn, "Work", &["n1", "n2"]))
    });
    assert!(matches!(again, Err(BeginError::Unsettled)), "{again:?}");
    assert!(!run(&db, |conn| folder_delete::abandon(conn, "Other")));
    assert!(run(&db, |conn| folder_delete::abandon(conn, "Work")));
    assert_eq!(pending(&db), []);
}

#[test]
fn a_folder_no_record_can_name_is_deleted_with_its_notes() {
    let db = open("folder-delete-unnamed");
    create(&db, "n1", "Plan", Some(" pad"));
    give_row(&db, "n1", " pad/Plan.md");
    clear_outbox(&db);
    run(&db, |conn| Ok(folder_delete::begin(conn, " pad", &["n1"]))).unwrap();
    run(&db, |conn| {
        folder_delete::deleted_by_app(conn, " pad", &["n1"], DEVICE, NOW + 1)
    });
    assert_eq!(live_notes(&db), Vec::<String>::new());
    assert_eq!(pending(&db), []);
}

/// A row the note delete cannot tombstone (a journal day's, a row with no note) refuses the
/// delete before anything is recorded, so the folder never reaches the trash.
#[test]
fn a_folder_holding_what_no_note_delete_takes_is_refused_unrecorded() {
    let db = work("folder-delete-not-a-note");
    let refused = run(&db, |conn| {
        Ok(folder_delete::begin(conn, "Work", &["n1", "j2025-01-01"]))
    });
    assert!(
        matches!(&refused, Err(BeginError::NotANote(id)) if id == "j2025-01-01"),
        "{refused:?}"
    );
    assert_eq!(pending(&db), []);
}

/// A record of a version this build does not know is reported, refuses the next delete, and is
/// never forgotten here.
#[test]
fn a_record_another_build_wrote_is_reported_and_kept() {
    let db = work("folder-delete-unreadable");
    run(&db, |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('notes.folder_delete.v1:Work', '{\"version\":2}')",
            [],
        )
        .unwrap();
        Ok(())
    });
    let unreadable = FolderDeleteRecorded::Unreadable("Work".into(), "a version 2 record".into());
    assert_eq!(pending(&db), std::slice::from_ref(&unreadable));
    let again = run(&db, |conn| Ok(folder_delete::begin(conn, "Work", &["n1"])));
    assert!(matches!(again, Err(BeginError::Unreadable(_))), "{again:?}");
    assert!(!run(&db, |conn| folder_delete::abandon(conn, "Work")));
    assert_eq!(pending(&db), [unreadable]);
}
