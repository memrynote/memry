//! The journal day a vault file is, against real SQLite (desktop Step 13m, #3530).
//!
//! | Test                                                             | Rule                                 |
//! | ---------------------------------------------------------------- | ------------------------------------ |
//! | a day file creates its day with the file's dates, once           | `newMarkdownFileId`, §1.9.1 minting  |
//! | a day already here is the file's only when its text is           | a file is named only on evidence     |
//! | a day another file holds, a foreign holder, a date no record ... | one file per day, §1.9.1             |
//! | a deleted day comes back with its file only on evidence          | a revive shows the body it had       |
//! | an Electron vault the core did not import creates no day         | Electron's days come from Step 36    |
//! | a removed day file deletes its day once, on the row's evidence   | `enqueueJournalDelete`, §5.8         |
//! | a day's file is fed and read back as a note's                    | one body feed, chapter 07 §7.1       |

#![cfg(feature = "markdown")]

mod note_identity_support;

use std::collections::HashMap;

use memry_core::domain::external_feed::{self, FeedInput, FeedOutcome};
use memry_core::domain::journal;
use memry_core::domain::notes::identity::{
    self, Adopted, Deferral, ELECTRON_IMPORT_META_KEY, Removed,
};
use memry_core::domain::notes::journal_day::{self, FileDay};
use memry_core::domain::write_back::{self, BodyRead};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use memry_core::sync::body_debt;
use note_identity_support::{
    BORN, DEVICE, Embeds, NOW, TOUCHED, clear_outbox, create, give_body, give_row, give_row_hashes,
    open, outbox, pulled_item, run, set_meta,
};
use rusqlite::params;
use serde_json::{Value, json};

const DAY: &str = "j2025-01-14";
const PATH: &str = "journal/2025-01-14.md";
const UNDECIDED: Adopted = Adopted::Deferred(Deferral::Undecided);

fn day_file(body: &'static str) -> FileDay<'static> {
    FileDay {
        path: PATH,
        date: "2025-01-14",
        body,
        created_ms: BORN,
        modified_ms: TOUCHED,
        electron_db_beside: false,
    }
}

fn converter() -> Converter {
    Converter::new(CalloutTypes::new(Vec::new()))
}

fn adopt(db: &Db, file: FileDay<'_>) -> Adopted {
    let converter = converter();
    db.call_blocking(|conn| {
        Ok(journal_day::adopt_day(
            conn,
            Some(&converter),
            None,
            &file,
            DEVICE,
            NOW,
        ))
    })
    .expect("a database call")
    .expect("an answer")
}

fn day_payload(db: &Db, id: &str) -> Value {
    run(db, |conn| {
        let raw = sync_items::push_payload(conn, "journal", id)?.expect("a payload");
        Ok(serde_json::from_str(&raw).expect("valid JSON"))
    })
}

/// The day's entry: its id, and whether it is deleted.
fn entry(db: &Db, date: &str) -> Option<(String, bool)> {
    run(db, |conn| journal::entry_for(conn, date))
}

fn created(id: &str) -> Adopted {
    Adopted::Created(id.to_owned())
}

#[test]
fn a_day_file_creates_its_day_with_the_files_dates_once() {
    let db = open("day-create");
    assert_eq!(adopt(&db, day_file("A day.\n")), created(DAY));
    let stored = day_payload(&db, DAY);
    assert_eq!(stored["date"], json!("2025-01-14"));
    assert_eq!(stored["content"], json!(""));
    assert_eq!(stored["createdAt"], json!("2023-11-14T22:13:20.000Z"));
    assert_eq!(stored["modifiedAt"], json!("2023-11-14T22:21:40.000Z"));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), DAY.to_owned())]);

    // A crash between the create and the row: asked again, the empty day is the file's.
    assert_eq!(
        adopt(&db, day_file("A day.\n")),
        Adopted::Existing(DAY.to_owned())
    );
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), DAY.to_owned())]);
}

#[test]
fn a_day_already_here_is_the_files_only_when_its_text_is() {
    let db = open("day-pulled");
    let pulled =
        json!({"date": "2025-01-14", "content": "The day's text\n", "clock": {"device-b": 1}});
    pulled_item(&db, "journal", DAY, &pulled);
    assert_eq!(adopt(&db, day_file("Another text\n")), UNDECIDED);
    assert_eq!(
        adopt(&db, day_file("The day's text\n")),
        Adopted::Existing(DAY.to_owned())
    );

    // A body that is not here yet says nothing.
    run(&db, |conn| body_debt::owe(conn, DAY));
    assert_eq!(adopt(&db, day_file("The day's text\n")), UNDECIDED);
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_day_another_file_holds_a_foreign_holder_and_a_date_no_record_holds_defer() {
    let db = open("day-held");
    assert_eq!(adopt(&db, day_file("A day.\n")), created(DAY));
    give_row(&db, DAY, "journal/2025/2025-01-14.md");
    clear_outbox(&db);
    assert_eq!(adopt(&db, day_file("A day.\n")), UNDECIDED);

    // A day an older build gave a note id (§1.9.1) is the day-merge drain's.
    run(&db, |conn| {
        conn.execute(
            "INSERT INTO journal_entries (id, date) VALUES ('legacy12345a', '2025-01-15')",
            [],
        )
        .map(drop)
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    });
    let foreign = FileDay {
        path: "journal/2025-01-15.md",
        date: "2025-01-15",
        ..day_file("x")
    };
    assert_eq!(adopt(&db, foreign), UNDECIDED);

    // Electron's file names take a 31st of every month; the record holds real days only.
    let no_day = FileDay {
        path: "journal/2025-02-31.md",
        date: "2025-02-31",
        ..day_file("x")
    };
    assert_eq!(adopt(&db, no_day), UNDECIDED);
    assert_eq!(
        entry(&db, "2025-01-15").map(|(id, _)| id).as_deref(),
        Some("legacy12345a")
    );
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_deleted_day_comes_back_with_its_file_only_on_evidence() {
    let db = open("day-revive");
    assert_eq!(adopt(&db, day_file("Old text\n")), created(DAY));
    give_body(&db, DAY, PATH, "Old text\n");
    run(&db, |conn| {
        journal::delete_day(conn, "2025-01-14", DEVICE, NOW + 1)
    });
    assert_eq!(entry(&db, "2025-01-14"), Some((DAY.to_owned(), true)));
    clear_outbox(&db);

    // Revived over another text, the day would show the body it was deleted with.
    assert_eq!(adopt(&db, day_file("Other text\n")), UNDECIDED);
    assert_eq!(entry(&db, "2025-01-14"), Some((DAY.to_owned(), true)));
    assert!(outbox(&db).is_empty());

    assert_eq!(adopt(&db, day_file("Old text\n")), created(DAY));
    assert_eq!(entry(&db, "2025-01-14"), Some((DAY.to_owned(), false)));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), DAY.to_owned())]);
}

#[test]
fn an_electron_vault_the_core_did_not_import_creates_no_day() {
    let db = open("day-electron");
    let beside = FileDay {
        electron_db_beside: true,
        ..day_file("A day.\n")
    };
    assert_eq!(
        adopt(&db, beside),
        Adopted::Deferred(Deferral::ElectronNotImported)
    );
    assert_eq!(entry(&db, "2025-01-14"), None);
    assert!(outbox(&db).is_empty());

    set_meta(&db, ELECTRON_IMPORT_META_KEY, "{\"version\":1}");
    assert_eq!(adopt(&db, beside), created(DAY));
}

#[test]
fn a_removed_day_file_deletes_its_day_once_on_the_rows_evidence() {
    let db = open("day-remove");
    assert_eq!(adopt(&db, day_file("A day.\n")), created(DAY));
    give_row_hashes(&db, DAY, PATH, None, Some("bytes"));
    clear_outbox(&db);
    let removed = run(&db, |conn| {
        identity::removed(conn, DAY, PATH, DEVICE, NOW + 1)
    });
    assert_eq!(removed, Removed::Undecided);
    assert_eq!(entry(&db, "2025-01-14"), Some((DAY.to_owned(), false)));
    assert!(outbox(&db).is_empty());

    give_row(&db, DAY, PATH);
    let removed = run(&db, |conn| {
        identity::removed(conn, DAY, PATH, DEVICE, NOW + 2)
    });
    assert_eq!(removed, Removed::Deleted);
    assert_eq!(entry(&db, "2025-01-14"), Some((DAY.to_owned(), true)));
    assert_eq!(outbox(&db), vec![("delete".to_owned(), DAY.to_owned())]);
    assert!(day_payload(&db, DAY).get("bodyStateVector").is_some());

    // A crash before the row went: asked again, nothing more is written.
    let again = run(&db, |conn| {
        identity::removed(conn, DAY, PATH, DEVICE, NOW + 3)
    });
    assert_eq!(again, Removed::Deleted);
    assert_eq!(outbox(&db).len(), 1);
}

#[test]
fn a_days_file_is_fed_and_read_back_as_a_notes() {
    let db = open("day-feed");
    assert_eq!(adopt(&db, day_file("")), created(DAY));
    clear_outbox(&db);
    give_body(&db, DAY, PATH, "First words\n");
    let types: Vec<String> = run(&db, |conn| {
        let mut statement = conn
            .prepare("SELECT item_type FROM outbox WHERE item_id = ?1")
            .expect("prepare");
        let rows = statement
            .query_map(params![DAY], |row| row.get(0))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    });
    assert!(
        !types.is_empty() && types.iter().all(|t| t == "journal"),
        "{types:?}"
    );

    let converter = converter();
    let embeds = Embeds(HashMap::new());
    let read = db
        .call_blocking(|conn| {
            Ok(write_back::body_for_file(
                conn,
                &converter,
                DAY,
                PATH,
                "First words\n",
                &embeds,
            ))
        })
        .unwrap()
        .unwrap();
    let BodyRead::Body(body) = read else {
        panic!("no body: {read:?}");
    };
    assert_eq!(body.markdown.trim_end(), "First words");
    assert_eq!(
        run(&db, |conn| write_back::journal_date(conn, DAY)).as_deref(),
        Some("2025-01-14")
    );

    // Replaced from the file, the body it had is kept as a version titled by its day.
    let input = FeedInput {
        note_id: DAY,
        markdown: "Second words\n",
        note_path: Some(PATH),
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    let outcome = db
        .call_blocking(|conn| {
            Ok(external_feed::feed_external_edit(
                conn, &converter, input, DEVICE, NOW,
            ))
        })
        .unwrap()
        .unwrap();
    assert_eq!(outcome, FeedOutcome::Fed);
    let titles: Vec<String> = run(&db, |conn| {
        let mut statement = conn
            .prepare("SELECT title FROM note_snapshots WHERE note_id = ?1")
            .expect("prepare");
        let rows = statement
            .query_map(params![DAY], |row| row.get(0))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    });
    assert_eq!(titles, vec!["2025-01-14".to_owned()]);

    // A note has no day; a deleted day has no body to feed.
    create(&db, "n1", "Plan", None);
    assert_eq!(run(&db, |conn| write_back::journal_date(conn, "n1")), None);
    run(&db, |conn| {
        journal::delete_day(conn, "2025-01-14", DEVICE, NOW + 1)
    });
    let input = FeedInput {
        note_id: DAY,
        markdown: "Third words\n",
        note_path: Some(PATH),
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    let outcome = db
        .call_blocking(|conn| {
            Ok(external_feed::feed_external_edit(
                conn, &converter, input, DEVICE, NOW,
            ))
        })
        .unwrap()
        .unwrap();
    assert_eq!(outcome, FeedOutcome::NoNote);
}
