//! Local-only notes on real SQLite (desktop Step 13, `notes:set-local-only`).
//!
//! | Test                                                   | Rule                                   |
//! | ------------------------------------------------------ | -------------------------------------- |
//! | an ordinary note queues its record and body            | the gate does not touch other notes    |
//! | a local-only note queues nothing, whatever is written  | the one gate in `outbox::enqueue`      |
//! | the note's own state is still written                  | only the push is withheld              |
//! | turning it on drops what was already queued            | the second before the toggle           |
//! | turning it off queues the record and the whole body    | the server receives the whole note     |
//! | a second device rebuilds the body from the pushed row  | full state is a valid update           |
//! | turning it off twice queues once                       | idempotent                             |
//! | a delete while local-only pushes no tombstone          | desktop `pending-deletes.ts`           |
//! | an unknown note is not found                           | no row, no change                      |
//! | a body over the update cap is reported, never queued   | chapter 07 §7.3                        |

use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log;
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::notes::local_only::{self, BodyPush, LocalOnlyChange};
use memry_core::domain::{body_write, note_files, notes};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::Value;

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-local-only-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

fn create_note(db: &Db, id: &'static str) {
    run(db, move |conn| {
        notes::create(
            conn,
            &notes::NewNote {
                id,
                title: id,
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        note_files::upsert_stat(
            conn,
            &NoteFileStat {
                note_id: id.to_owned(),
                path: format!("{id}.md"),
                file_type: "markdown".to_owned(),
                mime_type: None,
                file_size: Some(1),
                content_hash: None,
                indexed_at: NOW,
            },
        )
    });
}

fn type_line(db: &Db, id: &'static str, block: &'static str, text: impl Into<String>) {
    let text: String = text.into();
    run(db, move |conn| {
        body_write::edit_block(
            conn,
            id,
            &BlockEdit::InsertParagraph {
                after_block_id: None,
                text,
                new_block_id: block.to_owned(),
            },
            DEVICE,
            NOW + 1,
        )
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    });
}

/// `(item_id, op)` of every outbox row, oldest first.
fn queued(db: &Db) -> Vec<(String, String)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT item_id, op FROM outbox ORDER BY id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    })
}

fn ops(db: &Db) -> Vec<String> {
    queued(db).into_iter().map(|(_, op)| op).collect()
}

fn set(db: &Db, id: &'static str, on: bool) -> Result<LocalOnlyChange, StorageError> {
    db.call_blocking(move |conn| local_only::set(conn, id, on, NOW + 2))
}

fn title_of(db: &Db, id: &'static str) -> String {
    run(db, move |conn| {
        Ok(conn
            .query_row("SELECT title FROM notes WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .expect("the projection row"))
    })
}

fn rename(db: &Db, id: &'static str, title: &'static str) {
    run(db, move |conn| {
        notes::rename(conn, id, title, DEVICE, NOW + 3)?.acknowledge();
        Ok(())
    });
}

fn clear_outbox(db: &Db) {
    run(db, |conn| {
        conn.execute("DELETE FROM outbox", [])
            .map(drop)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    });
}

#[test]
fn an_ordinary_note_queues_its_record_and_its_body() {
    let db = open("ordinary");
    create_note(&db, "n1");
    type_line(&db, "n1", "a", "hello");
    rename(&db, "n1", "Renamed");

    // The rename's record row supersedes the create's: one row per record.
    assert_eq!(ops(&db), ["crdt-update", "upsert"]);
}

#[test]
fn a_local_only_note_queues_nothing_and_still_keeps_its_own_state() {
    let db = open("silent");
    create_note(&db, "n1");
    clear_outbox(&db);
    set(&db, "n1", true).expect("on");

    type_line(&db, "n1", "a", "secret");
    rename(&db, "n1", "Renamed while local only");

    assert_eq!(queued(&db), Vec::<(String, String)>::new());
    assert_eq!(title_of(&db, "n1"), "Renamed while local only");
    let payload: Value = run(&db, |conn| {
        Ok(serde_json::from_str(
            &memry_core::storage::repositories::sync_items::push_payload(conn, "note", "n1")?
                .expect("a payload"),
        )
        .expect("json"))
    });
    assert_eq!(payload["title"], "Renamed while local only");
    let logged: i64 = run(&db, |conn| {
        Ok(conn
            .query_row("SELECT COUNT(*) FROM yjs_updates", [], |row| row.get(0))
            .expect("count"))
    });
    assert_eq!(logged, 1, "the body is kept locally");
}

#[test]
fn a_note_with_no_files_row_is_never_withheld() {
    let db = open("no-row");
    run(&db, |conn| {
        notes::create(
            conn,
            &notes::NewNote {
                id: "n9",
                title: "ios style",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        Ok(())
    });
    assert_eq!(ops(&db), ["upsert"]);
}

#[test]
fn turning_it_on_drops_the_rows_queued_before_the_toggle() {
    let db = open("drop");
    create_note(&db, "n1");
    create_note(&db, "n2");
    type_line(&db, "n1", "a", "typed just before");
    assert_eq!(queued(&db).len(), 3);

    let change = set(&db, "n1", true).expect("on");

    assert_eq!(change, LocalOnlyChange::Enabled { dropped: 2 });
    assert_eq!(queued(&db), [("n2".to_owned(), "upsert".to_owned())]);
    assert_eq!(
        set(&db, "n1", true).expect("again"),
        LocalOnlyChange::Unchanged
    );
}

#[test]
fn turning_it_off_queues_the_record_and_the_whole_body_once() {
    let db = open("off");
    create_note(&db, "n1");
    type_line(&db, "n1", "a", "first line");
    set(&db, "n1", true).expect("on");
    type_line(&db, "n1", "b", "written while local only");
    assert_eq!(queued(&db), Vec::<(String, String)>::new());

    let change = set(&db, "n1", false).expect("off");

    assert_eq!(
        change,
        LocalOnlyChange::Disabled {
            body: BodyPush::Queued
        }
    );
    assert_eq!(ops(&db), ["upsert", "crdt-update"]);
    assert_eq!(
        set(&db, "n1", false).expect("again"),
        LocalOnlyChange::Unchanged
    );
    assert_eq!(ops(&db).len(), 2, "clearing twice queues nothing more");

    // A device that has never seen the note rebuilds the whole body from the
    // one update the server is sent.
    let update: Vec<u8> = run(&db, |conn| {
        Ok(conn
            .query_row(
                "SELECT payload FROM outbox WHERE op = 'crdt-update'",
                [],
                |row| row.get(0),
            )
            .expect("the body row"))
    });
    let sink: UpdateSink = Arc::new(|_, _| {});
    let peer = DocumentRegistry::new("device-b", sink)
        .get_or_open("n1")
        .expect("a document");
    peer.apply_durable_update(&update).expect("apply");
    let text = extract_text(&peer).expect("text");
    assert!(text.contains("first line"), "{text}");
    assert!(text.contains("written while local only"), "{text}");
}

#[test]
fn a_delete_while_local_only_pushes_no_tombstone() {
    let db = open("delete");
    create_note(&db, "n1");
    set(&db, "n1", true).expect("on");

    run(&db, |conn| {
        notes::delete(conn, "n1", DEVICE, NOW + 4)?.acknowledge();
        Ok(())
    });

    assert_eq!(queued(&db), Vec::<(String, String)>::new());
    let deleted: Option<i64> = run(&db, |conn| {
        Ok(conn
            .query_row("SELECT deleted_at FROM notes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .expect("the row"))
    });
    assert!(deleted.is_some(), "the note is deleted here");
}

#[test]
fn an_unknown_note_is_not_found_and_nothing_changes() {
    let db = open("unknown");
    let error = set(&db, "missing", true).expect_err("no such note");
    assert!(matches!(error, StorageError::NotFound { .. }), "{error:?}");
}

#[test]
fn a_note_without_a_body_queues_only_its_record_when_cleared() {
    let db = open("empty");
    create_note(&db, "n1");
    set(&db, "n1", true).expect("on");

    let change = set(&db, "n1", false).expect("off");

    assert_eq!(
        change,
        LocalOnlyChange::Disabled {
            body: BodyPush::Empty
        }
    );
    assert_eq!(ops(&db), ["upsert"]);
}

/// `len` bytes that deflate barely at all: a 64-symbol alphabet driven by an
/// xorshift stream, about six bits of entropy per byte.
fn incompressible(len: usize) -> String {
    const ALPHABET: &[u8; 64] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            char::from(ALPHABET[(state % 64) as usize])
        })
        .collect()
}

fn is_local_only(db: &Db, id: &'static str) -> bool {
    run(db, move |conn| note_files::is_local_only(conn, id))
}

#[test]
fn a_body_the_server_would_refuse_refuses_the_toggle_and_writes_nothing() {
    let db = open("refused");
    create_note(&db, "n1");
    set(&db, "n1", true).expect("on");
    // About 6 MiB of entropy-heavy text seals to more than the 5 MiB the
    // server takes as one update (chapter 07 §7.3).
    type_line(&db, "n1", "a", incompressible(8 * 1024 * 1024));

    let change = set(&db, "n1", false).expect("answered");

    match change {
        LocalOnlyChange::TooLargeToSync { packed_bytes } => {
            assert!(packed_bytes > 5 * 1024 * 1024, "{packed_bytes}");
        }
        other => panic!("expected TooLargeToSync, got {other:?}"),
    }
    assert_eq!(
        queued(&db),
        Vec::<(String, String)>::new(),
        "no record without its body"
    );
    assert!(is_local_only(&db, "n1"), "the flag stayed on");

    // The invariant that matters: the next edit cannot reach the server either,
    // so no delta ever depends on history the server never got.
    type_line(&db, "n1", "b", "a later line");
    assert_eq!(queued(&db), Vec::<(String, String)>::new());
}

#[test]
fn a_compressible_body_over_the_cap_raw_still_syncs() {
    let db = open("compressible");
    create_note(&db, "n1");
    set(&db, "n1", true).expect("on");
    type_line(&db, "n1", "a", "x".repeat(6 * 1024 * 1024));

    let change = set(&db, "n1", false).expect("off");

    assert_eq!(
        change,
        LocalOnlyChange::Disabled {
            body: BodyPush::Queued
        }
    );
    assert_eq!(ops(&db), ["upsert", "crdt-update"]);
    assert!(!is_local_only(&db, "n1"));
}

#[test]
fn a_peers_record_and_body_reach_a_local_only_note_and_queue_nothing() {
    // The peer authors a body on its own device.
    let peer = open("peer");
    create_note(&peer, "n1");
    type_line(&peer, "n1", "p", "typed on the other device");
    let update: Vec<u8> = run(&peer, |conn| {
        Ok(conn
            .query_row(
                "SELECT payload FROM outbox WHERE op = 'crdt-update'",
                [],
                |row| row.get(0),
            )
            .expect("the peer's body row"))
    });

    let db = open("local");
    create_note(&db, "n1");
    set(&db, "n1", true).expect("on");
    let mut record: Value =
        run(&db, |conn| {
            Ok(serde_json::from_str(
                &sync_items::push_payload(conn, "note", "n1")?.expect("a payload"),
            )
            .expect("json"))
        });
    record["title"] = Value::from("Edited by the peer");
    record["clock"] = serde_json::json!({"device-a": 1, "device-b": 1});
    let inbound = InboundRecord {
        item_type: "note".to_owned(),
        item_id: "n1".to_owned(),
        payload_json: record.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW + 10,
        deleted_at: None,
    };

    run(&db, move |conn| {
        apply_inbound(conn, &inbound, NOW + 10)?;
        update_log::append_server_update(conn, "n1", 1, &update, NOW + 10).map_err(|error| {
            StorageError::Failed {
                what: error.to_string(),
            }
        })
    });

    assert_eq!(title_of(&db, "n1"), "Edited by the peer");
    assert_eq!(queued(&db), Vec::<(String, String)>::new());
    assert!(is_local_only(&db, "n1"));
    let body = run(&db, |conn| {
        let sink: UpdateSink = Arc::new(|_, _| {});
        let document = DocumentRegistry::new("device-a", sink)
            .get_or_open("n1")
            .expect("a document");
        for blob in update_log::load_plan(conn, "n1")
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?
            .blobs()
        {
            document.apply_durable_update(blob).expect("apply");
        }
        Ok(extract_text(&document).expect("text"))
    });
    assert!(body.contains("typed on the other device"), "{body}");
}

#[test]
fn turning_it_on_keeps_a_queued_delete() {
    let db = open("keeps-delete");
    create_note(&db, "n1");
    run(&db, |conn| {
        notes::delete(conn, "n1", DEVICE, NOW + 1)?.acknowledge();
        Ok(())
    });
    assert_eq!(ops(&db), ["delete"]);

    let change = set(&db, "n1", true).expect("on");

    assert_eq!(change, LocalOnlyChange::Enabled { dropped: 0 });
    assert_eq!(ops(&db), ["delete"], "a tombstone is not content");
}
