//! An outside edit of a file's frontmatter `tags:` taken into its record (desktop, #3825),
//! against real SQLite.
//!
//! | Test                                                         | Rule                          |
//! | ------------------------------------------------------------ | ----------------------------- |
//! | a note's record takes its file's header tags, once           | the file owns a note's header |
//! | a deleted note takes nothing                                 | a delete stays a delete       |
//! | a day's record takes what the edit changed in its file's list | the record owns a day's tags  |
//! | a day with no kept list is read against the index              | an older build's day          |
//! | a deleted day takes nothing and is not revived               | a delete stays a delete       |

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::journal;
use memry_core::domain::journal_ops::metadata;
use memry_core::domain::notes::{self, NewNote, file_tags};
use memry_core::domain::tags;
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use note_identity_support::{DEVICE, NOW, clear_outbox, open, outbox, payload, run};
use serde_json::{Value, json};

const NOTE: &str = "n-plan";
const DAY: &str = "j2025-03-03";
const DATE: &str = "2025-03-03";

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|tag| (*tag).to_owned()).collect()
}

fn taken(db: &Db, id: &str, before: Option<&[&str]>, after: &[&str]) {
    let before = before.map(strings);
    run(db, |conn| {
        file_tags::taken(
            conn,
            id,
            before.as_deref(),
            &strings(after),
            DEVICE,
            NOW + 5,
        )
    });
}

fn note_with(db: &Db, tags: &[&str]) {
    let tags = strings(tags);
    let note = NewNote {
        id: NOTE,
        title: "Plan",
        folder_path: None,
        content: "",
        tags: &tags,
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

fn upserts(db: &Db) -> usize {
    outbox(db).iter().filter(|(op, _)| op == "upsert").count()
}

#[test]
fn a_notes_record_takes_its_files_header_tags_once() {
    let db = open("file-tags-note");
    note_with(&db, &["x", "pinned"]);
    run(&db, |conn| {
        tags::set_pinned(conn, NOTE, "pinned", true, DEVICE, NOW + 1)
    });
    clear_outbox(&db);

    taken(&db, NOTE, None, &["Y", "y"]);
    let stored = payload(&db, NOTE);
    assert_eq!(stored["tags"], json!(["Y"]), "case variants collapse");
    assert_eq!(stored["pinnedTags"], json!([]), "a dropped tag's pin goes");
    assert_eq!(upserts(&db), 1);

    clear_outbox(&db);
    taken(&db, NOTE, Some(&["x"]), &["Y"]);
    assert_eq!(payload(&db, NOTE)["tags"], json!(["Y"]));
    assert!(
        outbox(&db).is_empty(),
        "a list the record holds writes nothing"
    );
}

#[test]
fn a_deleted_note_takes_nothing() {
    let db = open("file-tags-deleted-note");
    note_with(&db, &["x"]);
    run(&db, |conn| {
        notes::delete(conn, NOTE, DEVICE, NOW + 1).map(drop)
    });
    clear_outbox(&db);
    taken(&db, NOTE, None, &["y"]);
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_days_record_takes_what_the_edit_changed_in_its_files_list() {
    let db = open("file-tags-day");
    run(&db, |conn| {
        metadata::set_tags(conn, DATE, &strings(&["walk", "picked"]), DEVICE, NOW)
    });
    clear_outbox(&db);

    // No list kept for the day: nothing to read the edit against.
    taken(&db, DAY, None, &["rain"]);
    assert_eq!(day_payload(&db)["tags"], json!(["walk", "picked"]));
    assert!(outbox(&db).is_empty());

    // The file's list as found: the next edit is read against it.
    run(&db, |conn| file_tags::seen(conn, DAY, &strings(&["rain"])));
    taken(&db, DAY, None, &["run"]);
    assert_eq!(day_payload(&db)["tags"], json!(["walk", "picked", "run"]));
    assert_eq!(upserts(&db), 1);

    clear_outbox(&db);
    // Against the kept list, never the index's: it says `run` was there, so nothing is new.
    taken(&db, DAY, Some(&[]), &["Run"]);
    taken(&db, DAY, Some(&[]), &["run"]);
    assert_eq!(day_payload(&db)["tags"], json!(["walk", "picked", "run"]));
    assert!(
        outbox(&db).is_empty(),
        "a respelling, or no change, takes nothing"
    );
}

/// A day an older build found keeps no list: the index's measure of the replaced file stands
/// in, and the take keeps the file's list from then on.
#[test]
fn a_day_with_no_kept_list_is_read_against_the_index() {
    let db = open("file-tags-day-indexed");
    run(&db, |conn| {
        metadata::set_tags(conn, DATE, &strings(&["walk", "picked"]), DEVICE, NOW)
    });
    clear_outbox(&db);
    taken(&db, DAY, Some(&["walk"]), &["run"]);
    assert_eq!(
        day_payload(&db)["tags"],
        json!(["picked", "run"]),
        "the record's own tag stays"
    );
    assert_eq!(upserts(&db), 1);
    taken(&db, DAY, None, &["run", "rain"]);
    assert_eq!(day_payload(&db)["tags"], json!(["picked", "run", "rain"]));
}

#[test]
fn a_deleted_day_takes_nothing_and_is_not_revived() {
    let db = open("file-tags-deleted-day");
    run(&db, |conn| {
        metadata::set_tags(conn, DATE, &strings(&["walk"]), DEVICE, NOW)
    });
    run(&db, |conn| journal::delete_day(conn, DATE, DEVICE, NOW + 1));
    clear_outbox(&db);
    taken(&db, DAY, Some(&[]), &["rain"]);
    assert!(outbox(&db).is_empty());
    assert_eq!(run(&db, |conn| journal::live_entry(conn, DATE)), None);
}
