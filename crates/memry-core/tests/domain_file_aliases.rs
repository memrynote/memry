//! The aliases an in-app edit wrote into a file, taken by its record (`notes:edit-aliases`,
//! #3530 13q-1), against real SQLite.
//!
//! | Test                                                   | Rule                            |
//! | ------------------------------------------------------ | ------------------------------- |
//! | a note's record takes the file's list, normalized, once | the file owns a note's names   |
//! | a deleted note takes nothing                           | a delete stays a delete         |
//! | a day's record takes the list, the date as its title    | days and notes alike           |
//! | a deleted day takes nothing and is not revived         | a delete stays a delete         |

#![cfg(feature = "markdown")]

use crate::note_identity_support;

use memry_core::domain::journal;
use memry_core::domain::journal_ops::metadata;
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use note_identity_support::{DEVICE, NOW, clear_outbox, open, outbox, payload, run};
use serde_json::{Value, json};

const NOTE: &str = "n-plan";
const DAY: &str = "j2025-03-03";
const DATE: &str = "2025-03-03";

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

fn take(db: &Db, id: &str, aliases: &[&str]) -> bool {
    let aliases = strings(aliases);
    run(db, |conn| {
        notes::take_file_aliases(conn, id, &aliases, DEVICE, NOW + 5)
    })
}

fn note(db: &Db) {
    let note = NewNote {
        id: NOTE,
        title: "Plan",
        folder_path: None,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    run(db, |conn| notes::create(conn, &note, DEVICE, NOW).map(drop));
}

fn day_payload(db: &Db) -> Value {
    run(db, |conn| {
        let raw = sync_items::push_payload(conn, "journal", DAY)?.expect("a payload");
        Ok(serde_json::from_str(&raw).expect("valid JSON"))
    })
}

#[test]
fn a_notes_record_takes_the_files_list_normalized_once() {
    let db = open("file-aliases-note");
    note(&db);
    clear_outbox(&db);

    assert!(take(&db, NOTE, &["New", "plan", " Other ", "new"]));
    assert_eq!(
        payload(&db, NOTE)["aliases"],
        json!(["New", "Other"]),
        "trimmed, deduped by name key, the title never an alias"
    );
    assert_eq!(outbox(&db).len(), 1);

    clear_outbox(&db);
    assert!(take(&db, NOTE, &["New", "Other"]));
    assert!(
        outbox(&db).is_empty(),
        "a list the record holds writes nothing"
    );

    assert!(take(&db, NOTE, &[]));
    assert_eq!(
        payload(&db, NOTE)["aliases"],
        json!([]),
        "the last one goes as []"
    );
}

#[test]
fn a_deleted_note_takes_nothing() {
    let db = open("file-aliases-deleted-note");
    note(&db);
    run(&db, |conn| {
        notes::delete(conn, NOTE, DEVICE, NOW + 1).map(drop)
    });
    clear_outbox(&db);
    assert!(!take(&db, NOTE, &["New"]));
    assert!(outbox(&db).is_empty());
    assert!(!take(&db, "n-none", &["New"]));
}

#[test]
fn a_days_record_takes_the_list_with_the_date_as_its_title() {
    let db = open("file-aliases-day");
    run(&db, |conn| {
        metadata::set_aliases(conn, DATE, &strings(&["Kickoff"]), DEVICE, NOW)
    });
    clear_outbox(&db);

    assert!(take(&db, DAY, &["Kickoff", "Launch", DATE]));
    assert_eq!(day_payload(&db)["aliases"], json!(["Kickoff", "Launch"]));
    assert_eq!(outbox(&db).len(), 1);

    clear_outbox(&db);
    assert!(take(&db, DAY, &["Kickoff", "Launch"]));
    assert!(
        outbox(&db).is_empty(),
        "a list the record holds writes nothing"
    );
}

#[test]
fn a_deleted_day_takes_nothing_and_is_not_revived() {
    let db = open("file-aliases-deleted-day");
    run(&db, |conn| {
        metadata::set_aliases(conn, DATE, &strings(&["Kickoff"]), DEVICE, NOW)
    });
    run(&db, |conn| journal::delete_day(conn, DATE, DEVICE, NOW + 1));
    clear_outbox(&db);
    assert!(!take(&db, DAY, &["Launch"]));
    assert!(outbox(&db).is_empty());
    assert_eq!(run(&db, |conn| journal::live_entry(conn, DATE)), None);
}
