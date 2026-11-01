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
//! | a recorded move reads back until its transaction ...   | the next open finishes or forgets  |
//! | a move whose transaction fails keeps its record ...    | the tier forgets it after put-back |
//! | a version 1 record with a field a later build added    | the `v1` record is a contract      |
//! | a record this build cannot read is never replaced ...  | left for the build that wrote it   |

#![cfg(feature = "markdown")]

mod note_identity_support;

use memry_core::api::errors::StorageError;
use memry_core::domain::note_files;
use memry_core::domain::notes::app_move::{self, AppMoved, PendingMove, Recorded};
use memry_core::domain::notes::identity;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, give_row, open, outbox, payload, place, position, run,
};
use rusqlite::OptionalExtension;
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

#[test]
fn a_recorded_move_reads_back_until_its_transaction_forgets_it() {
    let db = open("app-move-pending");
    create(&db, "n1", "Plan", Some("Work"));
    give_row(&db, "n1", "Work/Plan.md");
    let moved = AppMoved {
        old_path: "Work/Plan.md",
        new_path: "Work/Plan Q3.md",
        title: Some("Plan: Q3"),
        keeps_kind: true,
    };
    assert_eq!(run(&db, |conn| app_move::pending(conn)), None);

    run(&db, |conn| app_move::begin(conn, "n1", &moved));
    let recorded = PendingMove {
        note_id: "n1".to_owned(),
        old_path: "Work/Plan.md".to_owned(),
        new_path: "Work/Plan Q3.md".to_owned(),
        title: Some("Plan: Q3".to_owned()),
    };
    assert_eq!(
        run(&db, |conn| app_move::pending(conn)),
        Some(Recorded::Move(recorded))
    );

    run(&db, |conn| {
        app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1)
    });
    assert_eq!(run(&db, |conn| app_move::pending(conn)), None);
}

#[test]
fn a_move_whose_transaction_fails_keeps_its_record_and_abandon_forgets_it() {
    let db = open("app-move-pending-refused");
    create(&db, "n1", "Plan", None);
    create(&db, "n2", "Taken", None);
    give_row(&db, "n1", "Plan.md");
    give_row(&db, "n2", "Taken.md");
    let moved = AppMoved {
        old_path: "Plan.md",
        new_path: "Taken.md",
        title: None,
        keeps_kind: true,
    };
    run(&db, |conn| app_move::begin(conn, "n1", &moved));
    let refused =
        db.call_blocking(|conn| app_move::moved_by_app(conn, "n1", &moved, DEVICE, NOW + 1));
    assert!(refused.is_err());
    assert!(run(&db, |conn| app_move::pending(conn)).is_some());

    run(&db, |conn| app_move::abandon(conn));
    assert_eq!(run(&db, |conn| app_move::pending(conn)), None);
}

fn put_record(db: &memry_core::storage::Db, value: &str) {
    run(db, |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [app_move::APP_MOVE_META_KEY, value],
        )
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    });
}

fn raw_record(db: &memry_core::storage::Db) -> Option<String> {
    run(db, |conn| {
        conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [app_move::APP_MOVE_META_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
}

#[test]
fn a_version_1_record_with_a_field_a_later_build_added_reads() {
    let db = open("app-move-record-later-field");
    put_record(
        &db,
        r#"{"version":1,"noteId":"n1","oldPath":"a.pdf","newPath":"b.pdf","title":null,"later":1}"#,
    );
    let read = run(&db, |conn| app_move::pending(conn));
    let Some(Recorded::Move(read)) = read else {
        panic!("{read:?}")
    };
    assert_eq!((read.old_path.as_str(), read.title), ("a.pdf", None));
}

/// Another version's record, or one that does not parse, is left exactly as it was by every
/// call: the version that wrote it finishes it.
#[test]
fn a_record_this_build_cannot_read_is_never_replaced_or_deleted() {
    let db = open("app-move-record-unknown");
    create(&db, "n1", "Plan", None);
    give_row(&db, "n1", "Plan.md");
    let moved = AppMoved {
        old_path: "Plan.md",
        new_path: "Later.md",
        title: Some("Later"),
        keeps_kind: true,
    };
    for (n, value) in [
        "not json",
        r#"{"version":2,"noteId":"n1","oldPath":"Plan.md","newPath":"Later.md"}"#,
        r#"{"noteId":"n1","oldPath":"Plan.md","newPath":"Later.md","title":null}"#,
        r#"{"version":1,"noteId":7}"#,
    ]
    .into_iter()
    .enumerate()
    {
        put_record(&db, value);
        let read = run(&db, |conn| app_move::pending(conn));
        assert!(
            matches!(read, Some(Recorded::Unknown(_))),
            "{value}: {read:?}"
        );

        run(&db, |conn| app_move::abandon(conn));
        let refused = db.call_blocking(|conn| app_move::begin(conn, "n1", &moved));
        assert!(refused.is_err(), "{value}");
        // A title given in place still runs the transaction that forgets a version 1 record.
        let title = format!("Plan {n}");
        let in_place = AppMoved {
            old_path: "Plan.md",
            new_path: "Plan.md",
            title: Some(&title),
            keeps_kind: true,
        };
        run(&db, |conn| {
            app_move::moved_by_app(conn, "n1", &in_place, DEVICE, NOW + 1)
        });
        assert_eq!(payload(&db, "n1")["title"], json!(title));
        assert_eq!(raw_record(&db).as_deref(), Some(value));
    }
}
