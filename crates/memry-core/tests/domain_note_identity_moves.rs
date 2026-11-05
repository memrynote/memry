//! A note's file moved or removed, against real SQLite (desktop Step 13d, #3530).
//!
//! | Test                                                      | Rule                                |
//! | --------------------------------------------------------- | ----------------------------------- |
//! | a rename edits title and folder once, keeps or drops slot | Electron `processRename`, #1646     |
//! | a removed file deletes its note once                      | §5.8, one tombstone                 |
//! | a removal the row does not say is the whole note keeps it | never a delete that may lose more   |
//! | a local-only note's removal pushes nothing                | the gate in `outbox::enqueue`       |
//! | a move left owed keeps its first path until it is applied | evidence first, never a guess       |
//! | a crossing deletes once and stays owed while its row is   | `renameKeepsJournalDate`, crash-safe |

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::api::errors::StorageError;
use memry_core::domain::note_files;
use memry_core::domain::notes::identity::{self, Crossing, Moved, OwedPlace, Removed};
use memry_core::domain::notes::local_only;
use memry_core::domain::owed_file_body;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::sync::body_debt;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, deleted, give_body, give_body_at, give_row, give_row_hashes,
    open, outbox, payload, place, position, pulled_deleted, pulled_item, run,
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

/// A tombstone deletes the note on every device, so a removal deletes it only when the row says
/// the file held the whole note. Otherwise the note stays and nothing is pushed: a row that
/// knows no bytes on disk (a move of the file would not pair, so the removal may be one), a
/// document that does not hold the bytes on disk (another text, or a file body owed), and a
/// body edited after the row's stamp (an edit the file never got), and a body owed a pull (the
/// server holds text no file had).
#[test]
fn a_removal_whose_row_does_not_say_the_file_held_the_note_keeps_it() {
    let db = open("undecided");
    let rows: [(&str, Option<&str>, Option<&str>); 5] = [
        ("hashless", None, None),
        ("unpaired", Some("hash"), None),
        ("untaken", None, Some("bytes")),
        ("other", Some("hash"), Some("bytes")),
        ("ahead", Some("hash"), Some("hash")),
    ];
    let mut paths = Vec::new();
    for (id, content, file) in rows {
        let path = format!("{id}.md");
        create(&db, id, id, None);
        give_row_hashes(&db, id, &path, content, file);
        paths.push(path);
    }
    run(&db, |conn| owed_file_body::record(conn, "ahead", NOW));
    create(&db, "edited", "edited", None);
    give_body(&db, "edited", "edited.md", "The file's text\n");
    give_row(&db, "edited", "edited.md");
    give_body_at(&db, "edited", "edited.md", "Typed after\n", NOW + 1);
    paths.push("edited.md".to_owned());
    create(&db, "pulling", "pulling", None);
    give_row(&db, "pulling", "pulling.md");
    run(&db, |conn| body_debt::owe(conn, "pulling"));
    paths.push("pulling.md".to_owned());
    let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    place(&db, "", &path_refs);
    clear_outbox(&db);
    for path in &paths {
        let id = path.strip_suffix(".md").unwrap();
        let removed = run(&db, |conn| {
            identity::removed(conn, id, path, DEVICE, NOW + 2)
        });
        assert_eq!(removed, Removed::Undecided, "{id}");
        assert!(!deleted(&db, id), "{id}");
        assert!(position(&db, path).is_some(), "{id}");
    }
    assert!(outbox(&db).is_empty());

    // The document took the file: the row names it again, and a removal is a removal.
    run(&db, |conn| owed_file_body::clear(conn, "ahead"));
    let removed = run(&db, |conn| {
        identity::removed(conn, "ahead", "ahead.md", DEVICE, NOW + 3)
    });
    assert_eq!(removed, Removed::Deleted);
    // The write-back wrote the edit: the row's stamp is after it.
    run(&db, |conn| {
        conn.execute(
            "UPDATE note_files SET indexed_at = ?2 WHERE note_id = ?1",
            rusqlite::params!["edited", NOW + 1],
        )
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    });
    let removed = run(&db, |conn| {
        identity::removed(conn, "edited", "edited.md", DEVICE, NOW + 3)
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

/// A move that changed what the file is deletes the note as a removal does, and owes the move
/// while the row is there: a crash before the tier drops the row is found by the next open,
/// whose ask deletes nothing more. One the removal may not delete is only owed.
#[test]
fn a_crossing_deletes_once_and_stays_owed_while_its_row_is() {
    let db = open("crossed");
    create(&db, "n1", "2025-01-06", None);
    give_row(&db, "n1", "journal/2025-01-06.md");
    place(&db, "", &["2025-01-06.md"]);
    clear_outbox(&db);
    let crossed = cross(
        &db,
        "n1",
        "2025-01-06.md",
        "journal/2025-01-06.md",
        Some("2025-01-06"),
        "",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Deleted);
    assert!(deleted(&db, "n1"));
    assert_eq!(outbox(&db), vec![("delete".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "2025-01-06.md"), None);
    let n1 = OwedPlace {
        note_id: "n1".to_owned(),
        from_path: "2025-01-06.md".to_owned(),
        path: "journal/2025-01-06.md".to_owned(),
    };
    assert_eq!(owed(&db), vec![n1]);

    clear_outbox(&db);
    let again = cross(
        &db,
        "n1",
        "2025-01-06.md",
        "journal/2025-01-06.md",
        Some("2025-01-06"),
        "",
        NOW + 2,
    );
    assert_eq!(again, Removed::Deleted);
    assert!(outbox(&db).is_empty());
    run(&db, |conn| {
        conn.execute("DELETE FROM note_files WHERE note_id = 'n1'", [])
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    });
    assert!(owed(&db).is_empty());

    create(&db, "kept", "Kept", None);
    give_row_hashes(&db, "kept", "journal/2025-01-07.md", None, None);
    clear_outbox(&db);
    let kept = cross(
        &db,
        "kept",
        "Kept.md",
        "journal/2025-01-07.md",
        Some("2025-01-07"),
        "",
        NOW + 3,
    );
    assert_eq!(kept, Removed::Undecided);
    assert!(!deleted(&db, "kept"));
    assert!(outbox(&db).is_empty());
    assert_eq!(owed(&db).len(), 1);

    // To a day that is here already: the file is not that day, so the note stays, owed.
    pulled_item(
        &db,
        "journal",
        "j2025-01-08",
        &json!({"date": "2025-01-08", "content": "Here\n", "clock": {"device-b": 1}}),
    );
    create(&db, "held", "Held", None);
    give_row(&db, "held", "journal/2025-01-08.md");
    clear_outbox(&db);
    let held = cross(
        &db,
        "held",
        "Held.md",
        "journal/2025-01-08.md",
        Some("2025-01-08"),
        "",
        NOW + 4,
    );
    assert_eq!(held, Removed::Undecided);
    assert!(!deleted(&db, "held"));
    assert!(outbox(&db).is_empty());
    assert_eq!(owed(&db).len(), 2);
}

/// The notes owed a move, read from the table itself: [`identity::owed_places`] leaves out a
/// debt whose row is gone, which is the debt that must not outlive it.
fn owed_raw(db: &memry_core::storage::Db) -> Vec<String> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT note_id FROM note_place_owed ORDER BY note_id")
            .unwrap();
        Ok(statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap())
    })
}

fn day_deleted(db: &memry_core::storage::Db, id: &str) -> bool {
    run(db, |conn| {
        Ok(conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM journal_entries WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .expect("the day"))
    })
}

/// A day's entry deleted before with another text, and a note's file moved onto its path (the
/// day moved out, edited as a note and moved back, or its file deleted and another moved
/// there): the file cannot become that day, so the note is not deleted for it. It stays, owed.
#[test]
fn a_crossing_onto_a_deleted_day_keeps_the_note_owed() {
    let db = open("crossed-deleted-day");
    pulled_item(
        &db,
        "journal",
        "j2025-01-09",
        &json!({"date": "2025-01-09", "content": "Gone\n", "clock": {"device-b": 1}}),
    );
    give_body(&db, "j2025-01-09", "journal/2025-01-09.md", "Gone\n");
    pulled_deleted(&db, "journal", "j2025-01-09");
    assert!(day_deleted(&db, "j2025-01-09"));
    create(&db, "meeting", "Meeting", None);
    give_row(&db, "meeting", "journal/2025-01-09.md");
    clear_outbox(&db);
    let crossed = cross(
        &db,
        "meeting",
        "Meeting.md",
        "journal/2025-01-09.md",
        Some("2025-01-09"),
        "Agenda\n",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Undecided);
    assert!(!deleted(&db, "meeting"));
    assert!(outbox(&db).is_empty());
    assert_eq!(owed_raw(&db), vec!["meeting".to_owned()]);
}

/// A day moved out of the journal: its entry is deleted as a day (`journal`), once, owed the
/// move while its row is; the row's removal ends the debt.
#[test]
fn a_day_moved_out_of_the_journal_is_deleted_once_and_its_debt_goes_with_its_row() {
    let db = open("crossed-day-out");
    pulled_item(
        &db,
        "journal",
        "j2025-01-10",
        &json!({"date": "2025-01-10", "content": "Out\n", "clock": {"device-b": 1}}),
    );
    give_row(&db, "j2025-01-10", "Notes/2025-01-10.md");
    clear_outbox(&db);
    let crossed = cross(
        &db,
        "j2025-01-10",
        "journal/2025-01-10.md",
        "Notes/2025-01-10.md",
        None,
        "",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Deleted);
    assert!(day_deleted(&db, "j2025-01-10"));
    assert_eq!(
        outbox(&db),
        vec![("delete".to_owned(), "j2025-01-10".to_owned())]
    );
    assert_eq!(owed_raw(&db), vec!["j2025-01-10".to_owned()]);

    clear_outbox(&db);
    let again = cross(
        &db,
        "j2025-01-10",
        "journal/2025-01-10.md",
        "Notes/2025-01-10.md",
        None,
        "",
        NOW + 2,
    );
    assert_eq!(again, Removed::Deleted);
    assert!(outbox(&db).is_empty());

    run(&db, |conn| note_files::remove(conn, "j2025-01-10"));
    assert!(owed_raw(&db).is_empty(), "{:?}", owed_raw(&db));
}

/// The record `id`'s file crossed from `from` to `to`, where it holds `body`
/// ([`identity::crossed`]), away from Electron's database.
fn cross(
    db: &memry_core::storage::Db,
    id: &str,
    from: &str,
    to: &str,
    day: Option<&str>,
    body: &str,
    now: i64,
) -> Removed {
    cross_beside(db, id, (from, to), day, body, false, now)
}

fn cross_beside(
    db: &memry_core::storage::Db,
    id: &str,
    (from, to): (&str, &str),
    day: Option<&str>,
    body: &str,
    electron_db_beside: bool,
    now: i64,
) -> Removed {
    let (folder_path, name) = to
        .rsplit_once('/')
        .map_or((None, to), |(f, n)| (Some(f), n));
    let crossing = Crossing {
        from_path: from,
        path: to,
        title: name.strip_suffix(".md").unwrap_or(name),
        folder_path,
        day,
        body,
        electron_db_beside,
    };
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    db.call_blocking(|conn| {
        Ok(identity::crossed(
            conn,
            Some(&converter),
            None,
            id,
            &crossing,
            DEVICE,
            now,
        ))
    })
    .expect("a database call")
    .expect("an answer")
}

/// The same move with the day's own text (the day moved out and back unedited): the file is
/// that day again, revived as Electron makes it (`newMarkdownFileId`), so the note is deleted.
#[test]
fn a_crossing_onto_a_deleted_day_with_its_text_deletes_the_note() {
    let db = open("crossed-deleted-day-same");
    pulled_item(
        &db,
        "journal",
        "j2025-01-11",
        &json!({"date": "2025-01-11", "clock": {"device-b": 1}}),
    );
    give_body(&db, "j2025-01-11", "journal/2025-01-11.md", "Back\n");
    pulled_deleted(&db, "journal", "j2025-01-11");
    create(&db, "out", "2025-01-11", Some("Notes"));
    give_row(&db, "out", "journal/2025-01-11.md");
    clear_outbox(&db);
    let from = "Notes/2025-01-11.md";
    let crossed = cross(
        &db,
        "out",
        from,
        "journal/2025-01-11.md",
        Some("2025-01-11"),
        "Back\n",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Deleted);
    assert!(deleted(&db, "out"));
    assert_eq!(outbox(&db), vec![("delete".to_owned(), "out".to_owned())]);
}

/// A day's path whose date no record holds (`2025-02-31`, which a file name allows): the file
/// is never that day, so the note crossing there stays, owed, and nothing is pushed.
#[test]
fn a_crossing_to_a_date_no_record_holds_keeps_the_note_owed() {
    let db = open("crossed-bad-date");
    create(&db, "n", "Note", None);
    give_row(&db, "n", "journal/2025-02-31.md");
    clear_outbox(&db);
    let crossed = cross(
        &db,
        "n",
        "Note.md",
        "journal/2025-02-31.md",
        Some("2025-02-31"),
        "",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Undecided);
    assert!(!deleted(&db, "n"));
    assert!(outbox(&db).is_empty());
    assert_eq!(owed_raw(&db), vec!["n".to_owned()]);
}

/// Beside an Electron database the core did not import, the tier makes no new item for a
/// file: the crossing deletes nothing. Away from it, the same move deletes.
#[test]
fn a_crossing_beside_an_unimported_electron_database_keeps_the_note_owed() {
    let db = open("crossed-beside-electron");
    create(&db, "n", "Note", None);
    give_row(&db, "n", "journal/2025-01-12.md");
    clear_outbox(&db);
    let moved = ("Note.md", "journal/2025-01-12.md");
    let beside = cross_beside(&db, "n", moved, Some("2025-01-12"), "", true, NOW + 1);
    assert_eq!(beside, Removed::Undecided);
    assert!(!deleted(&db, "n"));
    assert!(outbox(&db).is_empty());
    let away = cross_beside(&db, "n", moved, Some("2025-01-12"), "", false, NOW + 2);
    assert_eq!(away, Removed::Deleted);
}

/// A day moved out to the path of a note no row names: that note claims the file, so the day
/// is not deleted for it. It stays, owed.
#[test]
fn a_day_crossing_onto_a_claimed_notes_path_keeps_the_day_owed() {
    let db = open("crossed-claimed");
    pulled_item(
        &db,
        "journal",
        "j2025-01-13",
        &json!({"date": "2025-01-13", "clock": {"device-b": 1}}),
    );
    give_row(&db, "j2025-01-13", "Notes/Plan.md");
    create(&db, "plan", "Plan", Some("Notes"));
    clear_outbox(&db);
    let crossed = cross(
        &db,
        "j2025-01-13",
        "journal/2025-01-13.md",
        "Notes/Plan.md",
        None,
        "",
        NOW + 1,
    );
    assert_eq!(crossed, Removed::Undecided);
    assert!(!day_deleted(&db, "j2025-01-13"));
    assert!(outbox(&db).is_empty());
}
