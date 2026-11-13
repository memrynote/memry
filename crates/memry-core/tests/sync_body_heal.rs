//! Which documents the one-time body heal owes (#4315).
//!
//! Real SQLite through `open_data`; each row of the table is one document in
//! one body state, and the heal must owe exactly the live notes and journals
//! that hold no body state at all.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::storage::open_data;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::sync::body_debt;
use memry_core::sync::body_heal::owe_unread_documents;
use rusqlite::{Connection, params};
use serde_json::json;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// The body state a document is left in before the heal runs.
#[derive(Clone, Copy, Debug)]
enum State {
    /// The record alone.
    Bare,
    /// A pending record change in the outbox, such as a rename.
    Outbox,
    /// Text typed here, still under the `local.` namespace.
    LocalUpdate,
    /// A snapshot under the `local.` namespace.
    LocalSnapshot,
    /// An update pulled from the server.
    PulledUpdate,
    /// A body cursor, from a pull that met an empty log.
    Cursor,
    /// Deleted.
    Tombstone,
}

/// Document id, type, state, owed by the heal.
const CASES: &[(&str, &str, State, bool)] = &[
    ("bare-note", "note", State::Bare, true),
    ("j2026-11-10", "journal", State::Bare, true),
    ("outbox-note", "note", State::Outbox, true),
    ("local-update", "note", State::LocalUpdate, false),
    ("local-snapshot", "note", State::LocalSnapshot, false),
    ("pulled-update", "note", State::PulledUpdate, false),
    ("cursor-note", "note", State::Cursor, false),
    ("j2026-11-11", "journal", State::Cursor, false),
    ("dead-note", "note", State::Tombstone, false),
    ("j2026-11-12", "journal", State::Tombstone, false),
];

fn arrange(conn: &Connection, id: &str, item_type: &str, state: State) {
    let payload = match item_type {
        "journal" => json!({"date": &id[1..], "content": "", "clock": {"device-b": 1}}),
        _ => json!({"title": id, "clock": {"device-b": 1}}),
    };
    sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: id.to_owned(),
            payload_json: payload.to_string(),
            server_cursor: Some(5),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: 1,
            deleted_at: matches!(state, State::Tombstone).then_some(2),
        },
        1,
    )
    .expect("apply the record");
    let sql = match state {
        State::Bare | State::Tombstone => return,
        State::Outbox => {
            "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('note', ?1, 'upsert', 1)"
        }
        State::LocalUpdate => {
            "INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES ('local.' || ?1, 1, x'00', 1)"
        }
        State::LocalSnapshot => {
            "INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, compacted_at) VALUES ('local.' || ?1, x'00', 1, 1)"
        }
        State::PulledUpdate => {
            "INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?1, 1, x'00', 1)"
        }
        State::Cursor => {
            "INSERT INTO sync_cursors (scope, cursor, updated_at) VALUES ('crdt:' || ?1, '0', 1)"
        }
    };
    conn.execute(sql, params![id])
        .expect("arrange the body state");
}

#[test]
fn the_heal_owes_each_live_document_without_body_state() {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf =
        std::env::temp_dir().join(format!("memry-body-heal-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    let db = open_data(&dir.join("data.db")).expect("open data.db");

    let (count, owed) = db
        .call_blocking(|conn| {
            for (id, item_type, state, _) in CASES {
                arrange(conn, id, item_type, *state);
            }
            // `apply_remote` owes a fresh record's body; the broken installs
            // the heal is for had that debt settled.
            for (id, ..) in CASES {
                body_debt::settle(conn, id)?;
            }
            let count = owe_unread_documents(conn)?;
            Ok::<_, StorageError>((count, body_debt::owed(conn)?))
        })
        .expect("run the heal");

    let mut expected: Vec<&str> = CASES
        .iter()
        .filter(|(.., owed)| *owed)
        .map(|(id, ..)| *id)
        .collect();
    expected.sort_unstable();
    let mut owed = owed;
    owed.sort();
    assert_eq!(owed, expected);
    assert_eq!(count, expected.len());
    std::fs::remove_dir_all(&dir).ok();
}
