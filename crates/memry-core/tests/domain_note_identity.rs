//! The note a vault file is, against real SQLite (desktop Step 13d, #3530).
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | a new file creates a note with its dates and queues it once | Electron `indexer.ts` new file        |
//! | a file date no record can carry is the creation's           | never asked about forever             |
//! | a pulled record whose text is the file's keeps its id       | an id is never minted twice           |
//! | a note whose text is not the file's defers                  | a file is named only on evidence      |
//! | a note holding a resolved image embed is the file's         | the feed's embeds, 12f-3b             |
//! | a note whose body is not here yet defers                    | evidence first, never a guess         |
//! | asked again before the row, the same note answers           | idempotent across create and row      |
//! | a tombstone, a filed note, a file note never match          | one note per file, markdown only      |
//! | case and Unicode normalization are part of the title        | exact, as Electron's titles           |
//! | an Electron vault the core did not import mints nothing     | Electron ids come from Step 36 only   |
//! | the vault's origin is recorded once                         | never rewritten                       |

#![cfg(feature = "markdown")]

mod note_identity_support;

use std::collections::HashMap;

use memry_core::domain::notes::identity::{
    self, Adopted, Deferral, ELECTRON_IMPORT_META_KEY, FileNote, Origin, VAULT_ORIGIN_META_KEY,
};
use memry_core::sync::body_debt;
use note_identity_support::{
    Embeds, adopt, adopt_with, clear_outbox, create, file, give_body, give_body_with, give_row,
    note_count, outbox, payload, pulled, pulled_item, run, set_meta,
};
use rusqlite::OptionalExtension as _;
use serde_json::{Value, json};

const WITHHELD: Adopted = Adopted::Deferred(Deferral::ElectronNotImported);
const UNDECIDED: Adopted = Adopted::Deferred(Deferral::Undecided);

fn created(id: &str) -> Adopted {
    Adopted::Created(id.to_owned())
}

fn existing(id: &str) -> Adopted {
    Adopted::Existing(id.to_owned())
}

fn record(title: &str, folder: Option<&str>, content: &str) -> Value {
    json!({
        "title": title,
        "content": content,
        "fileType": "markdown",
        "folderPath": folder,
        "clock": {"device-b": 3},
        "createdAt": "2025-01-01T00:00:00.000Z",
        "modifiedAt": "2025-01-02T00:00:00.000Z",
    })
}

fn beside_electron(file: FileNote<'static>) -> FileNote<'static> {
    FileNote {
        electron_db_beside: true,
        ..file
    }
}

#[test]
fn a_new_file_creates_a_note_with_the_files_dates_and_queues_it_once() {
    let db = note_identity_support::open("create");
    assert_eq!(
        adopt(&db, file("Work/2025/Plan.md", "x"), "new1"),
        created("new1")
    );
    let stored = payload(&db, "new1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], json!("Work/2025"));
    assert_eq!(stored["fileType"], json!("markdown"));
    assert_eq!(stored["content"], json!(""));
    assert_eq!(stored["createdAt"], json!("2023-11-14T22:13:20.000Z"));
    assert_eq!(stored["modifiedAt"], json!("2023-11-14T22:21:40.000Z"));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "new1".to_owned())]);

    assert_eq!(adopt(&db, file("Inbox.md", "x"), "new2"), created("new2"));
    assert_eq!(payload(&db, "new2")["folderPath"], Value::Null);
}

/// A record pulled before its file was written keeps the id every device knows, when the file
/// says what the note says.
/// A file date the record cannot carry (a corrupt far-future modification time) is the
/// creation's: refused, the file would be asked about at every open, and never named.
#[test]
fn a_file_date_no_record_can_carry_is_the_creations() {
    let db = note_identity_support::open("far-future");
    let corrupt = FileNote {
        created_ms: i64::MAX,
        modified_ms: i64::MAX,
        ..file("Plan.md", "Body\n")
    };
    assert_eq!(adopt(&db, corrupt, "n1"), created("n1"));
    let note = payload(&db, "n1");
    assert_eq!(note["createdAt"], "2025-10-09T08:53:20.000Z", "{note}");
    assert_eq!(note["modifiedAt"], "2025-10-09T08:53:20.000Z", "{note}");
}

#[test]
fn a_pulled_record_whose_text_is_the_files_keeps_its_id() {
    let db = note_identity_support::open("pulled");
    pulled(
        &db,
        "server-id",
        &record("Plan", Some("Work"), "Buy milk\n"),
    );
    assert_eq!(
        adopt(&db, file("Work/Plan.md", "Buy milk\r\n\n"), "minted"),
        existing("server-id")
    );
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());
}

/// A note whose body holds an Obsidian image embed (`![[img.png]]`, an image block once the
/// vault's lookup resolves it, 12f-3b) writes out as the file's text when the file's embeds are
/// resolved the same way: it is the file's note.
#[test]
fn a_note_whose_body_holds_a_resolved_image_embed_is_the_files() {
    let db = note_identity_support::open("embed");
    let text = "Before\n\n![[img.png]]\n\nAfter\n";
    let embeds = Embeds(HashMap::from([(
        "img.png".to_owned(),
        "file:///vault/img.png".to_owned(),
    )]));
    create(&db, "n1", "Plan", None);
    give_body_with(&db, "n1", "Plan.md", text, &embeds);
    clear_outbox(&db);
    assert_eq!(
        adopt_with(&db, file("Plan.md", text), "minted", Some(&embeds)),
        existing("n1")
    );
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());
}

/// A `Groceries.md` whose text is not the phone's note of that title may be another note (named
/// by it, deleting the file would delete that note everywhere) or the same note at another
/// version (Electron keys a note by its path; a new id would be a second copy). Neither is
/// evidence, so the file waits.
#[test]
fn a_note_whose_text_is_not_the_files_defers() {
    let db = note_identity_support::open("other");
    create(&db, "phone", "Groceries", None);
    give_body(&db, "phone", "Groceries.md", "Eggs and bread");
    pulled(&db, "pulled", &record("Groceries", None, "Milk\n"));
    clear_outbox(&db);
    assert_eq!(
        adopt(&db, file("Groceries.md", "A list from Finder\n"), "fresh"),
        UNDECIDED
    );
    assert_eq!(note_count(&db), 2);
    assert!(outbox(&db).is_empty());

    // The one note whose text is the file's is the file, whichever is older.
    assert_eq!(
        adopt(&db, file("Groceries.md", "Milk\n"), "unused"),
        existing("pulled")
    );

    // The text the phone's note holds is evidence it is the file.
    let db = note_identity_support::open("same-body");
    create(&db, "phone", "Groceries", None);
    give_body(&db, "phone", "Groceries.md", "Eggs and bread");
    clear_outbox(&db);
    assert_eq!(
        adopt(&db, file("Groceries.md", "Eggs and bread\n"), "unused"),
        existing("phone")
    );
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_note_whose_body_is_not_here_yet_defers() {
    let db = note_identity_support::open("owed");
    pulled(&db, "server-id", &record("Plan", None, ""));
    run(&db, |conn| body_debt::owe(conn, "server-id"));
    assert_eq!(
        adopt(&db, file("Plan.md", "Anything\n"), "minted"),
        UNDECIDED
    );
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());

    // Not even beside a note whose text is the file's: the one owed its body may be the file.
    pulled(&db, "younger", &record("Plan", None, "Anything\n"));
    assert_eq!(
        adopt(&db, file("Plan.md", "Anything\n"), "minted"),
        UNDECIDED
    );
    assert_eq!(note_count(&db), 2);

    // Without a converter to read the body with, a note that may be the file defers too.
    run(&db, |conn| body_debt::settle(conn, "server-id"));
    let answer = db
        .call_blocking(|conn| {
            Ok(identity::adopt(
                conn,
                None,
                None,
                &file("Plan.md", ""),
                "minted",
                "device-a",
                note_identity_support::NOW,
            ))
        })
        .unwrap()
        .unwrap();
    assert_eq!(answer, UNDECIDED);
}

/// A crash between the note's create and its row, before or after its body was seeded.
#[test]
fn asked_again_before_the_row_is_written_the_same_note_answers() {
    let db = note_identity_support::open("again");
    assert_eq!(
        adopt(&db, file("Plan.md", "Words\n"), "first"),
        created("first")
    );
    clear_outbox(&db);
    assert_eq!(
        adopt(&db, file("Plan.md", "Words\n"), "second"),
        existing("first")
    );
    give_body(&db, "first", "Plan.md", "Words\n");
    assert_eq!(
        adopt(&db, file("Plan.md", "Words\n"), "third"),
        existing("first")
    );
    assert_eq!(note_count(&db), 1);
}

#[test]
fn a_tombstone_a_filed_note_a_file_note_or_another_folder_never_matches() {
    let db = note_identity_support::open("no-match");
    create(&db, "gone", "Plan", None);
    run(&db, |conn| {
        memry_core::domain::notes::delete(conn, "gone", "device-a", 1).map(drop)
    });
    create(&db, "filed", "Plan", None);
    give_row(&db, "filed", "Plan.md");
    create(&db, "elsewhere", "Plan", Some("Work"));
    create(&db, "empty-folder", "Plan", Some(""));
    let mut pdf = record("Plan", None, "");
    pdf["fileType"] = json!("pdf");
    pdf["mimeType"] = json!("application/pdf");
    pulled(&db, "a-pdf", &pdf);

    assert_eq!(adopt(&db, file("Plan.md", "x"), "fresh"), created("fresh"));
    // The oldest of two unfiled notes answers, and only the folder the file is in.
    create(&db, "younger", "Plan", Some("Work"));
    assert_eq!(
        adopt(&db, file("Work/Plan.md", "x"), "unused"),
        existing("elsewhere")
    );
}

/// Pinned: a file name is matched to a title byte for byte, as Electron reads titles from file
/// names. A miss names a new note; it never claims another one.
#[test]
fn case_and_unicode_normalization_are_part_of_the_title() {
    let db = note_identity_support::open("exact");
    create(&db, "composed", "Caf\u{e9}", None);
    assert_eq!(
        adopt(&db, file("Cafe\u{301}.md", "x"), "decomposed"),
        created("decomposed")
    );
    assert_eq!(
        adopt(&db, file("caf\u{e9}.md", "x"), "lower"),
        created("lower")
    );
}

/// Opened before Step 36 imported it, an Electron vault mints no id, whatever records were
/// pulled into it. A core the app created over Electron's database is never imported, so it
/// never mints, even once files were named in it.
#[test]
fn an_electron_vault_the_core_did_not_import_mints_nothing() {
    let db = note_identity_support::open("electron");
    let plan = beside_electron(file("Plan.md", "x"));
    assert_eq!(adopt(&db, plan, "minted"), WITHHELD);
    let day = json!({"date": "2025-01-01", "content": "", "clock": {"device-b": 1}});
    pulled_item(&db, "journal", "j2025-01-01", &day);
    assert_eq!(adopt(&db, plan, "minted"), WITHHELD);
    pulled(&db, "pulled", &record("Other", None, ""));
    give_row(&db, "pulled", "Other.md");
    set_meta(&db, VAULT_ORIGIN_META_KEY, "electron");
    assert_eq!(adopt(&db, plan, "minted"), WITHHELD);
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());

    // Once the import marked the vault, a new file is a new note.
    set_meta(&db, ELECTRON_IMPORT_META_KEY, "{\"version\":1}");
    assert_eq!(adopt(&db, plan, "minted"), created("minted"));
}

#[test]
fn a_native_core_mints_beside_a_database_electron_added_later() {
    let db = note_identity_support::open("native");
    set_meta(&db, VAULT_ORIGIN_META_KEY, "native");
    let plan = beside_electron(file("Plan.md", "x"));
    assert_eq!(adopt(&db, plan, "minted"), created("minted"));

    // A core whose origin is not recorded mints nothing beside Electron's database, even once
    // a file was named in it: files are named without minting (a pulled record's).
    let db = note_identity_support::open("unrecorded");
    assert_eq!(adopt(&db, plan, "minted"), WITHHELD);
    create(&db, "named", "Named", None);
    give_row(&db, "named", "Named.md");
    assert_eq!(adopt(&db, plan, "minted"), WITHHELD);
    assert_eq!(note_count(&db), 1);
}

#[test]
fn the_vaults_origin_is_recorded_once() {
    let db = note_identity_support::open("origin");
    run(&db, |conn| {
        identity::record_origin(conn, Origin::OverElectron)
    });
    run(&db, |conn| identity::record_origin(conn, Origin::Native));
    let origin: Option<String> = run(&db, |conn| {
        Ok(conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [VAULT_ORIGIN_META_KEY],
                |row| row.get(0),
            )
            .optional()
            .expect("read"))
    });
    assert_eq!(origin.as_deref(), Some("electron"));
}
