//! New vault files made notes together, against real SQLite (#3530 13q-7): each note ends as
//! the one-file path leaves it (`identity::adopt`, then the feed's seed), the rules of `adopt`
//! hold in the batch's transaction, an error writes nothing, and a batch a crash left without
//! rows is adopted again, not created twice.

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use std::sync::Arc;

use memry_core::crdt::BODY_FRAGMENT;
use memry_core::crdt::registry::DocumentRegistry;
use memry_core::crdt::update_log::LOCAL_NAMESPACE_PREFIX;
use memry_core::domain::external_feed::{self, FeedInput, FeedOutcome, FirstBody};
use memry_core::domain::notes::identity::{self, Adopted, FileNote};
use memry_core::domain::notes::new_files::{NewFileNote, adopt_new};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::Db;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, file, note_count, outbox, payload, pulled, run,
};
use rusqlite::params;
use serde_json::{Value, json};
use yrs::types::ToJson as _;
use yrs::{Any, Doc, Transact as _, Update, updates::decoder::Decode as _};

const PLAN: &str = "# Plan\n\nShip the **first** open.\n\n- [ ] measure\n- [x] batch\n";
const LOG: &str = "Some words and [[Plan]].\n";

fn converter() -> Converter {
    Converter::new(CalloutTypes::new(Vec::new()))
}

fn input<'a>(id: &'a str, file: &FileNote<'a>) -> FeedInput<'a> {
    FeedInput {
        note_id: id,
        markdown: file.body,
        note_path: Some(file.path),
        writing: None,
        frontmatter: None,
        embeds: None,
    }
}

/// The body the file's text gives the note `id`, as `device` authors it.
fn body(id: &str, file: &FileNote<'_>, device: &str) -> FirstBody {
    external_feed::first_body(&converter(), input(id, file), device).expect("a body")
}

fn adopt_together(db: &Db, files: &[NewFileNote<'_>]) -> Vec<bool> {
    run(db, |conn| Ok(adopt_new(conn, files, DEVICE, NOW))).expect("an answer")
}

/// What the note's stored body log builds, as the converter reads it: its blocks, each block
/// id aside (a conversion gives each block a random one), and the recorded markdown source.
/// Two conversions of one text under one client id differ in nothing else; their bytes do,
/// in those ids and in the order of the source record's keys.
fn stored_body(db: &Db, id: &str) -> (Vec<Value>, Any) {
    let doc_id = format!("{LOCAL_NAMESPACE_PREFIX}{id}");
    let blobs: Vec<Vec<u8>> = run(db, move |conn| {
        let mut statement = conn
            .prepare("SELECT update_blob FROM yjs_updates WHERE doc_id = ?1 ORDER BY seq")
            .expect("prepare");
        let blobs = statement
            .query_map(params![doc_id], |row| row.get(0))
            .expect("query")
            .map(|blob| blob.expect("a blob"))
            .collect();
        Ok(blobs)
    });
    assert!(!blobs.is_empty(), "{id}: no body stored");
    let document = DocumentRegistry::new(DEVICE, Arc::new(|_, _: &[u8]| {}))
        .get_or_open(id)
        .expect("a document");
    for blob in &blobs {
        document.apply_durable_update(blob).expect("an update");
    }
    let mut blocks = converter()
        .blocks(&document, BODY_FRAGMENT)
        .expect("blocks");
    blocks.iter_mut().for_each(without_ids);
    let doc = Doc::new();
    let state = document.encode_state().expect("a state");
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("decode"))
        .expect("apply");
    let source = doc.get_or_insert_map("markdownSource");
    let source = source.to_json(&doc.transact());
    (blocks, source)
}

fn without_ids(block: &mut Value) {
    if let Some(block) = block.as_object_mut() {
        block.remove("id");
        if let Some(Value::Array(children)) = block.get_mut("children") {
            children.iter_mut().for_each(without_ids);
        }
    }
}

fn count_updates(db: &Db) -> i64 {
    run(db, |conn| {
        Ok(conn
            .query_row("SELECT count(*) FROM yjs_updates", [], |row| row.get(0))
            .expect("count"))
    })
}

/// What the feed's seed answers for the note: `Unchanged` when its body is the file's text.
fn seed(db: &Db, id: &str, file: &FileNote<'_>) -> FeedOutcome {
    let converter = converter();
    run(db, |conn| {
        Ok(external_feed::seed_body_if_empty(
            conn,
            &converter,
            input(id, file),
            DEVICE,
            NOW,
        ))
    })
    .expect("a seed")
}

#[test]
fn new_files_get_the_notes_and_bodies_the_one_file_path_gives_them() {
    let (plan, log) = (file("Work/Plan.md", PLAN), file("Log.md", LOG));
    let together = note_identity_support::open("together");
    let bodies = [body("n1", &plan, DEVICE), body("n2", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n1",
            body: &bodies[0],
        },
        NewFileNote {
            file: log,
            id: "n2",
            body: &bodies[1],
        },
    ];
    assert_eq!(adopt_together(&together, &files), [true, true]);

    let alone = note_identity_support::open("alone");
    for (file, id) in [(plan, "n1"), (log, "n2")] {
        assert_eq!(
            note_identity_support::adopt(&alone, file, id),
            Adopted::Created(id.to_owned())
        );
        assert_eq!(seed(&alone, id, &file), FeedOutcome::Fed);
    }

    let queued = |db: &Db| outbox(db);
    assert_eq!(queued(&together), queued(&alone));
    for (file, id) in [(plan, "n1"), (log, "n2")] {
        let (mut a, mut b) = (payload(&together, id), payload(&alone, id));
        // The clock and the stamps each write takes; everything else is the same.
        for p in [&mut a, &mut b] {
            p.as_object_mut().unwrap().remove("clock");
        }
        assert_eq!(a, b, "{id}");
        assert_eq!(a["title"], json!(file.title));
        assert_eq!(stored_body(&together, id), stored_body(&alone, id), "{id}");
        assert_eq!(seed(&together, id, &file), FeedOutcome::Unchanged, "{id}");
    }
}

#[test]
fn a_file_a_live_note_without_a_row_may_be_is_left_to_the_one_file_path() {
    let db = note_identity_support::open("claimed");
    pulled(
        &db,
        "pulled1",
        &json!({
            "title": "Plan",
            "content": "",
            "fileType": "markdown",
            "folderPath": "Work",
            "clock": {"device-b": 1},
            "createdAt": "2025-01-01T00:00:00.000Z",
            "modifiedAt": "2025-01-01T00:00:00.000Z",
        }),
    );
    let (plan, log) = (file("Work/Plan.md", PLAN), file("Log.md", LOG));
    let bodies = [body("n1", &plan, DEVICE), body("n2", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n1",
            body: &bodies[0],
        },
        NewFileNote {
            file: log,
            id: "n2",
            body: &bodies[1],
        },
    ];
    assert_eq!(adopt_together(&db, &files), [false, true]);
    assert_eq!(note_count(&db), 2);
    // Alone, the file is the pulled note: no second id.
    assert_eq!(
        note_identity_support::adopt(&db, plan, "n3"),
        Adopted::Existing("pulled1".to_owned())
    );
}

#[test]
fn beside_electron_s_database_a_vault_that_mints_nothing_creates_nothing_together() {
    let db = note_identity_support::open("electron");
    let plan = FileNote {
        electron_db_beside: true,
        ..file("Plan.md", PLAN)
    };
    let log = FileNote {
        electron_db_beside: true,
        ..file("Log.md", LOG)
    };
    let bodies = [body("n1", &plan, DEVICE), body("n2", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n1",
            body: &bodies[0],
        },
        NewFileNote {
            file: log,
            id: "n2",
            body: &bodies[1],
        },
    ];
    assert!(!run(&db, |conn| identity::mints_beside_electron(conn)));
    assert_eq!(adopt_together(&db, &files), [false, false]);
    assert_eq!(note_count(&db), 0);
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_body_authored_under_another_client_id_is_not_stored() {
    let db = note_identity_support::open("client");
    let plan = file("Plan.md", PLAN);
    let other = body("n1", &plan, "device-z");
    let files = [NewFileNote {
        file: plan,
        id: "n1",
        body: &other,
    }];
    assert_eq!(adopt_together(&db, &files), [false]);
    assert_eq!(note_count(&db), 0);
}

#[test]
fn a_body_authored_for_another_note_is_not_stored() {
    let db = note_identity_support::open("other-note");
    let plan = file("Plan.md", PLAN);
    let other = body("n1", &plan, DEVICE);
    let files = [NewFileNote {
        file: plan,
        id: "n2",
        body: &other,
    }];
    assert_eq!(adopt_together(&db, &files), [false]);
    assert_eq!(note_count(&db), 0);
}

/// A crash after the batch's transaction and before the rows: the next open's batch, with
/// ids minted anew, creates nothing, and each file alone adopts the note it got.
#[test]
fn a_batch_a_crash_left_without_rows_is_adopted_again_not_created_twice() {
    let db = note_identity_support::open("crashed");
    let (plan, log) = (file("Work/Plan.md", PLAN), file("Log.md", LOG));
    let first = [body("n1", &plan, DEVICE), body("n2", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n1",
            body: &first[0],
        },
        NewFileNote {
            file: log,
            id: "n2",
            body: &first[1],
        },
    ];
    assert_eq!(adopt_together(&db, &files), [true, true]);
    let queued = outbox(&db);

    let again = [body("n3", &plan, DEVICE), body("n4", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n3",
            body: &again[0],
        },
        NewFileNote {
            file: log,
            id: "n4",
            body: &again[1],
        },
    ];
    assert_eq!(adopt_together(&db, &files), [false, false]);
    assert_eq!(note_count(&db), 2);
    assert_eq!(outbox(&db), queued);
    for (file, id, fresh) in [(plan, "n1", "n3"), (log, "n2", "n4")] {
        assert_eq!(
            note_identity_support::adopt(&db, file, fresh),
            Adopted::Existing(id.to_owned())
        );
    }
    assert_eq!(note_count(&db), 2);
}

#[test]
fn an_error_in_the_batch_writes_none_of_it() {
    let db = note_identity_support::open("atomic");
    let (plan, log) = (file("Plan.md", PLAN), file("Log.md", LOG));
    let bodies = [body("n1", &plan, DEVICE), body("n2", &log, DEVICE)];
    let files = [
        NewFileNote {
            file: plan,
            id: "n1",
            body: &bodies[0],
        },
        // An id another note has: its create fails after the first note's was written.
        NewFileNote {
            file: log,
            id: "n2",
            body: &bodies[1],
        },
    ];
    create(&db, "n2", "Other", None);
    clear_outbox(&db);
    let answer = run(&db, |conn| Ok(adopt_new(conn, &files, DEVICE, NOW)));
    assert!(answer.is_err());
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());
    assert_eq!(count_updates(&db), 0);
}

#[test]
fn a_text_the_seed_would_not_take_has_no_first_body() {
    let large = "x".repeat(2 * 1024 * 1024);
    let file = FileNote {
        body: &large,
        ..file("Big.md", "")
    };
    assert!(external_feed::first_body(&converter(), input("n1", &file), DEVICE).is_none());
}
