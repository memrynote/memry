//! The app's own rename or move of a note's file, against real SQLite (desktop Step 13g,
//! #3530).
//!
//! | Test                                                   | Rule                               |
//! | ------------------------------------------------------ | ---------------------------------- |
//! | a rename takes the given title and keeps the slot      | Electron `renameNote`, #1646       |
//! | a move keeps the title and tops the new folder         | Electron `moveNote`                |
//! | a move that changes what the file is leaves it owed    | Step 13m, the watcher's rule       |
//! | a move whose row cannot move changes nothing           | one transaction, so a crash pairs  |
//! | a move the record was owed is settled                  | `identity::renamed`'s settle       |

#![cfg(feature = "markdown")]

mod note_identity_support;

use memry_core::domain::note_files;
use memry_core::domain::notes::app_move::{self, AppMoved};
use memry_core::domain::notes::identity;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, give_row, open, outbox, payload, place, position, run,
};
use serde_json::{Value, json};

fn row_path(db: &memry_core::storage::Db, id: &str) -> Option<String> {
    run(db, |conn| note_files::by_id(conn, id)).map(|row| row.path)
}

fn owed(db: &memry_core::storage::Db) -> Vec<(String, String)> {
    run(db, |conn| identity::owed_places(conn))
        .into_iter()
        .map(|owed| (owed.note_id, owed.from_path))
        .collect()
}

#[test]
fn a_rename_takes_the_given_title_and_keeps_the_slot() {
    let db = open("app-rename");
    create(&db, "n1", "Old", Some("Work"));
    give_row(&db, "n1", "Work/Old.md");
    place(&db, "Work", &["Work/Other.md", "Work/Old.md"]);
    clear_outbox(&db);
    // The title holds a character no file name can, so the file is named otherwise.
    let moved = AppMoved {
        old_path: "Work/Old.md",
        new_path: "Work/Plan - Q3.md",
        title: Some("Plan / Q3"),
        keeps_kind: true,
    };
    run(&db, |conn| {
        app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan / Q3"));
    assert_eq!(stored["folderPath"], json!("Work"));
    assert_eq!(stored["clock"], json!({"device-a": 2}));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(row_path(&db, "n1").as_deref(), Some("Work/Plan - Q3.md"));
    assert_eq!(position(&db, "Work/Old.md"), None);
    assert_eq!(
        position(&db, "Work/Plan - Q3.md"),
        Some(("Work".to_owned(), 1))
    );
}

#[test]
fn a_move_keeps_the_title_and_tops_the_new_folder() {
    let db = open("app-move");
    create(&db, "n1", "Plan", Some("Work"));
    give_row(&db, "n1", "Work/Plan.md");
    place(&db, "Work", &["Work/Plan.md"]);
    place(&db, "", &["A.md", "B.md"]);
    clear_outbox(&db);
    let moved = AppMoved {
        old_path: "Work/Plan.md",
        new_path: "Plan 1.md",
        title: None,
        keeps_kind: true,
    };
    run(&db, |conn| {
        app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], Value::Null);
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(row_path(&db, "n1").as_deref(), Some("Plan 1.md"));
    assert_eq!(position(&db, "Work/Plan.md"), None);
    // Above every placed sibling: `A.md` is 0.
    assert_eq!(position(&db, "Plan 1.md"), Some((String::new(), -1)));
}

/// A note moved into a day's path is not that day: the record keeps its place and is owed the
/// move, and nothing is pushed, as when the move is made outside the app.
#[test]
fn a_move_that_changes_what_the_file_is_leaves_the_record_owed() {
    let db = open("app-move-crossing");
    create(&db, "n1", "Plan", None);
    give_row(&db, "n1", "Plan.md");
    place(&db, "", &["Plan.md"]);
    clear_outbox(&db);
    let moved = AppMoved {
        old_path: "Plan.md",
        new_path: "journal/2025-01-14.md",
        title: None,
        keeps_kind: false,
    };
    run(&db, |conn| {
        app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], Value::Null);
    assert!(outbox(&db).is_empty());
    assert_eq!(
        row_path(&db, "n1").as_deref(),
        Some("journal/2025-01-14.md")
    );
    assert_eq!(owed(&db), vec![("n1".to_owned(), "Plan.md".to_owned())]);
    assert_eq!(position(&db, "Plan.md"), None);
}

/// The row moves last in the transaction; when it cannot (another note holds the path), the
/// record edit and the slot written before it are rolled back with it. The tier then moves the
/// file back, and nothing says the note moved.
#[test]
fn a_move_whose_row_cannot_move_changes_nothing() {
    let db = open("app-move-refused");
    create(&db, "n1", "Plan", Some("Work"));
    create(&db, "n2", "Taken", None);
    give_row(&db, "n1", "Work/Plan.md");
    give_row(&db, "n2", "Plan.md");
    place(&db, "Work", &["Work/Plan.md"]);
    clear_outbox(&db);
    let moved = AppMoved {
        old_path: "Work/Plan.md",
        new_path: "Plan.md",
        title: Some("Renamed"),
        keeps_kind: true,
    };
    let refused =
        db.call_blocking(|conn| app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1));

    assert!(refused.is_err());
    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], json!("Work"));
    assert!(outbox(&db).is_empty());
    assert_eq!(row_path(&db, "n1").as_deref(), Some("Work/Plan.md"));
    assert_eq!(position(&db, "Work/Plan.md"), Some(("Work".to_owned(), 0)));
}

#[test]
fn a_move_the_record_was_owed_is_settled() {
    let db = open("app-move-owed");
    create(&db, "n1", "Plan", None);
    give_row(&db, "n1", "journal/2025-01-14.md");
    run(&db, |conn| identity::owe_place(conn, "n1", "Plan.md", NOW));
    clear_outbox(&db);
    let moved = AppMoved {
        old_path: "journal/2025-01-14.md",
        new_path: "Work/Plan.md",
        title: None,
        keeps_kind: true,
    };
    run(&db, |conn| {
        app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    assert!(owed(&db).is_empty());
    assert_eq!(payload(&db, "n1")["folderPath"], json!("Work"));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
}
