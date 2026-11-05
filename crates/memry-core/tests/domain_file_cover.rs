//! The cover an in-app edit wrote into a note's file, taken by its record's `cover` field
//! (`notes:update` with `frontmatter`, #3530 13q-2), against real SQLite.
//!
//! | Test                                                        | Rule                               |
//! | ----------------------------------------------------------- | ---------------------------------- |
//! | a cover reaches the record once                             | the record carries the file's cover |
//! | a removed cover is null, with the legacy key, only if held  | no erasing a cover never held       |
//! | a deleted note takes nothing                                | a delete stays a delete             |

#![cfg(feature = "markdown")]

use crate::note_identity_support;

use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::Db;
use note_identity_support::{DEVICE, NOW, clear_outbox, open, outbox, payload, run};
use serde_json::{Map, Value, json};

const NOTE: &str = "n-plan";

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

fn take(db: &Db, cover: Value) -> bool {
    let cover: Option<Map<String, Value>> = cover.as_object().cloned();
    run(db, |conn| {
        notes::take_file_cover(conn, NOTE, cover.clone(), DEVICE, NOW + 5)
    })
}

#[test]
fn a_cover_reaches_the_record_once() {
    let db = open("file-cover-set");
    note(&db);
    clear_outbox(&db);
    let cover = json!({ "ref": "a.png", "focus": 30, "focusX": 50, "zoom": 1, "height": 200 });
    assert!(take(&db, cover.clone()));
    assert_eq!(payload(&db, NOTE)["cover"], cover);
    assert_eq!(outbox(&db).len(), 1);

    clear_outbox(&db);
    assert!(take(&db, cover));
    assert!(
        outbox(&db).is_empty(),
        "a cover the record holds writes nothing"
    );
}

#[test]
fn a_removed_cover_is_null_with_the_legacy_key_only_while_one_is_held() {
    let db = open("file-cover-remove");
    note(&db);
    clear_outbox(&db);
    assert!(take(&db, Value::Null));
    assert!(
        outbox(&db).is_empty(),
        "a record with no cover writes no null over a peer's"
    );
    assert_eq!(payload(&db, NOTE).get("cover"), None);

    assert!(take(&db, json!({ "ref": "wash:sage" })));
    clear_outbox(&db);
    assert!(take(&db, Value::Null));
    let stored = payload(&db, NOTE);
    assert_eq!(
        (&stored["cover"], &stored["coverImage"]),
        (&Value::Null, &Value::Null)
    );
    assert_eq!(outbox(&db).len(), 1);
}

#[test]
fn a_deleted_note_takes_nothing() {
    let db = open("file-cover-deleted");
    note(&db);
    run(&db, |conn| {
        notes::delete(conn, NOTE, DEVICE, NOW + 1).map(drop)
    });
    clear_outbox(&db);
    assert!(!take(&db, json!({ "ref": "wash:sage" })));
    assert!(outbox(&db).is_empty());
}
