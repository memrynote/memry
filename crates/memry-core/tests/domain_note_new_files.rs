//! New vault files made notes together, against real SQLite (#3530 13q-7): each note ends as
//! the one-file path leaves it (`identity::adopt`, then the feed's seed), the rules of `adopt`
//! hold in the batch's transaction, and an error writes nothing.

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::external_feed::{self, FeedInput, FeedOutcome, FirstBody};
use memry_core::domain::notes::identity::{self, Adopted, FileNote};
use memry_core::domain::notes::new_files::{NewFileNote, adopt_new};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::storage::Db;
use note_identity_support::{DEVICE, NOW, file, note_count, outbox, payload, pulled, run};
use serde_json::json;

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
        // Not a document id: its create fails after the first note's was written.
        NewFileNote {
            file: log,
            id: "not an id",
            body: &bodies[1],
        },
    ];
    let answer = run(&db, |conn| Ok(adopt_new(conn, &files, DEVICE, NOW)));
    assert!(answer.is_err());
    assert_eq!(note_count(&db), 0);
    assert!(outbox(&db).is_empty());
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
