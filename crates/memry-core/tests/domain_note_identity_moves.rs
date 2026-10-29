//! A note's file moved or removed, against real SQLite (desktop Step 13d, #3530).
//!
//! | Test                                                      | Rule                                |
//! | --------------------------------------------------------- | ----------------------------------- |
//! | a rename edits title and folder once, keeps or drops slot | Electron `processRename`, #1646     |
//! | a removed file deletes its note once                      | §5.8, one tombstone                 |
//! | a local-only note's removal pushes nothing                | the gate in `outbox::enqueue`       |
//! | a journal day keeps its record                            | Step 13m owns journal days          |

#![cfg(feature = "markdown")]

mod note_identity_support;

use memry_core::domain::notes::identity::{self, Moved, Removed};
use memry_core::domain::notes::local_only;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, deleted, give_row, open, outbox, payload, place, position,
    run,
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
