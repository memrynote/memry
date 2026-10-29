//! A note's file moved or removed, against real SQLite (desktop Step 13d, #3530).
//!
//! | Test                                                      | Rule                                |
//! | --------------------------------------------------------- | ----------------------------------- |
//! | a rename edits title and folder once, keeps or drops slot | Electron `processRename`, #1646     |
//! | a removed file deletes its note once                      | §5.8, one tombstone                 |
//! | a removal the row cannot tell from a move keeps the note  | never a delete that may be a move   |
//! | a local-only note's removal pushes nothing                | the gate in `outbox::enqueue`       |
//! | a journal day keeps its record                            | Step 13m owns journal days          |
//! | a move left owed keeps its first path until it is applied | evidence first, never a guess       |

#![cfg(feature = "markdown")]

mod note_identity_support;

use memry_core::domain::notes::identity::{self, Moved, OwedPlace, Removed};
use memry_core::domain::notes::local_only;
use memry_core::domain::owed_file_body;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, deleted, give_hashless_row, give_row, open, outbox, payload,
    place, position, run,
};
use serde_json::{Value, json};

#[test]
fn a_rename_in_its_folder_edits_the_title_once_and_keeps_the_slot() {
    let db = open("rename");
    create(&db, "n1", "Old", Some("Work"));
    place(&db, "Work", &["Work/Other.md", "Work/Old.md"]);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Work/Old.md",
        new_path: "Work/New.md",
        title: "New",
        folder_path: Some("Work"),
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("New"));
    assert_eq!(stored["folderPath"], json!("Work"));
    assert_eq!(stored["clock"], json!({"device-a": 2}));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Work/Old.md"), None);
    assert_eq!(position(&db, "Work/New.md"), Some(("Work".to_owned(), 1)));
}

#[test]
fn a_move_to_another_folder_edits_the_folder_and_drops_the_old_slot() {
    let db = open("move");
    create(&db, "n1", "Plan", Some("Work"));
    place(&db, "Work", &["Work/Plan.md"]);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Work/Plan.md",
        new_path: "Plan.md",
        title: "Plan",
        folder_path: None,
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], Value::Null);
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Work/Plan.md"), None);
    assert_eq!(position(&db, "Plan.md"), None);
}

/// A rename the record already says (the app's own rename, seen again) writes nothing.
#[test]
fn a_rename_the_record_already_says_queues_nothing() {
    let db = open("rename-same");
    create(&db, "n1", "Plan", None);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Old.md",
        new_path: "Plan.md",
        title: "Plan",
        folder_path: None,
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });
    assert!(outbox(&db).is_empty());
    assert_eq!(payload(&db, "n1")["clock"], json!({"device-a": 1}));
}

#[test]
fn a_removed_file_deletes_its_note_once() {
    let db = open("remove");
    create(&db, "n1", "Plan", None);
    give_row(&db, "n1", "Plan.md");
    place(&db, "", &["Plan.md"]);
    clear_outbox(&db);
    let removed = run(&db, |conn| {
        identity::removed(conn, "n1", "Plan.md", DEVICE, NOW + 1)
    });
    assert_eq!(removed, Removed::Deleted);
    assert!(deleted(&db, "n1"));
    assert_eq!(outbox(&db), vec![("delete".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Plan.md"), None);

    // A crash before the row went: asked again, nothing more is written.
    clear_outbox(&db);
    let again = run(&db, |conn| {
        identity::removed(conn, "n1", "Plan.md", DEVICE, NOW + 2)
    });
    assert_eq!(again, Removed::Deleted);
    assert!(outbox(&db).is_empty());
}

/// The tier pairs a move by the row's hash only. A row with none, or a note whose file is
/// ahead of its document (the row's hash is of an older text), cannot tell a removal from a
/// move whose new path the hash does not find: the note stays, and nothing is pushed.
#[test]
fn a_removal_the_row_cannot_tell_from_a_move_keeps_the_note() {
    let db = open("undecided");
    create(&db, "hashless", "A", None);
    give_hashless_row(&db, "hashless", "A.md");
    create(&db, "ahead", "B", None);
    give_row(&db, "ahead", "B.md");
    run(&db, |conn| owed_file_body::record(conn, "ahead", NOW));
    place(&db, "", &["A.md", "B.md"]);
    clear_outbox(&db);
    for (id, path) in [("hashless", "A.md"), ("ahead", "B.md")] {
        let removed = run(&db, |conn| {
            identity::removed(conn, id, path, DEVICE, NOW + 1)
        });
        assert_eq!(removed, Removed::Undecided, "{id}");
        assert!(!deleted(&db, id), "{id}");
        assert!(position(&db, path).is_some(), "{id}");
    }
    assert!(outbox(&db).is_empty());

    // The document took the file: the hash names it again, and a removal is a removal.
    run(&db, |conn| owed_file_body::clear(conn, "ahead"));
    let removed = run(&db, |conn| {
        identity::removed(conn, "ahead", "B.md", DEVICE, NOW + 2)
    });
    assert_eq!(removed, Removed::Deleted);
}

#[test]
fn a_local_only_notes_removal_pushes_nothing() {
    let db = open("local-only");
    create(&db, "n1", "Secret", None);
    give_row(&db, "n1", "Secret.md");
    run(&db, |conn| local_only::set(conn, "n1", true, NOW).map(drop));
    clear_outbox(&db);
    let removed = run(&db, |conn| {
        identity::removed(conn, "n1", "Secret.md", DEVICE, NOW + 1)
    });
    assert_eq!(removed, Removed::Deleted);
    assert!(deleted(&db, "n1"));
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_journal_days_removal_keeps_its_record() {
    let db = open("journal");
    let removed = run(&db, |conn| {
        identity::removed(conn, "j2025-01-01", "journal/2025-01-01.md", DEVICE, NOW)
    });
    assert_eq!(removed, Removed::Kept);
    assert!(outbox(&db).is_empty());
}

fn owed(db: &memry_core::storage::Db) -> Vec<OwedPlace> {
    run(db, |conn| identity::owed_places(conn))
}

/// A move the tier could not tell the meaning of: the record is left at the path it last
/// followed, and that path is kept through later moves, until a move reaches the record or
/// the note is deleted. Owing drops the note's slot at the path it left. A note whose row is
/// gone owes nothing.
#[test]
fn a_move_left_owed_keeps_its_first_path_until_it_is_applied() {
    let db = open("owed");
    create(&db, "n1", "Old", None);
    place(&db, "", &["Old.md"]);
    give_row(&db, "n1", "Daily/Old.md");
    run(&db, |conn| identity::owe_place(conn, "n1", "Old.md", NOW));
    // The path is free: another file there gets a slot of its own, which the owed move keeps.
    assert_eq!(position(&db, "Old.md"), None);
    place(&db, "", &["Old.md"]);
    run(&db, |conn| {
        identity::owe_place(conn, "n1", "Daily/Old.md", NOW + 1)
    });
    create(&db, "rowless", "Gone", None);
    run(&db, |conn| {
        identity::owe_place(conn, "rowless", "Gone.md", NOW)
    });
    let n1 = OwedPlace {
        note_id: "n1".to_owned(),
        from_path: "Old.md".to_owned(),
        path: "Daily/Old.md".to_owned(),
    };
    assert_eq!(owed(&db), vec![n1.clone()]);

    clear_outbox(&db);
    let moved = Moved {
        old_path: "Daily/Old.md",
        new_path: "Work/New.md",
        title: "New",
        folder_path: Some("Work"),
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 2)
    });
    assert!(owed(&db).is_empty());
    assert!(position(&db, "Old.md").is_some());
    assert_eq!(payload(&db, "n1")["folderPath"], json!("Work"));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);

    run(&db, |conn| {
        identity::owe_place(conn, "n1", "Work/New.md", NOW + 3)
    });
    run(&db, |conn| {
        identity::removed(conn, "n1", "Daily/Old.md", DEVICE, NOW + 4).map(drop)
    });
    // The note without a row lost its debt when the debts were listed: a row it gets later
    // is a file named anew, which owes nothing.
    give_row(&db, "rowless", "Gone.md");
    assert!(owed(&db).is_empty());
}
