//! #5356 (REVIEW-5362): the change feed lands a body fetched before the
//! document was deleted, purged and written again. Landed, it is the purged
//! body inside the revived one, and the next edit builds on content the server
//! purged (#5351). The landing checks the epoch `held_bodies` read before the
//! fetch, and owes the document instead.
use crate::http_fakes;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::domain::journal;
use memry_core::domain::journal_ops::body;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{CrdtCipher, PackedUpdate};
use memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL;
use memry_core::sync::pull::{
    META_CURSOR_SKIP_REPAIR, META_RECORD_DECLARATION, PullLoop, RecordCipher,
};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use rusqlite::Connection;
use serde_json::json;
use yrs::updates::decoder::Decode as _;
use yrs::{ReadTxn as _, Transact as _, Update};

const DAY: &str = "2099-06-15";
const DAY_ID: &str = "j2099-06-15";
type Interleave = Box<dyn FnOnce(&Db) + Send>;

struct Interleaving {
    db: Db,
    hook: Mutex<Option<Interleave>>,
}
impl CrdtCipher for Interleaving {
    fn open(&self, u: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if let Some(h) = self.hook.lock().unwrap().take() {
            h(&self.db);
        }
        Ok(u.packed.to_vec())
    }
}
struct NoRecords;
impl RecordCipher for NoRecords {
    fn open(&self, _e: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}
fn scratch(label: &str) -> Db {
    let dir = crate::support::scratch_dir(&format!("feed-revive-{label}")).keep();
    open_data(&dir.join("data.db")).unwrap()
}
fn write_day(conn: &Connection, text: &str, block: &str, device: &str, now: i64) {
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.into(),
        new_block_id: block.into(),
    };
    body::edit_day(conn, DAY, &edit, device, now).unwrap();
}
fn queued(db: &Db) -> Vec<Vec<u8>> {
    db.call_blocking(|c| {
        let mut s = c
            .prepare("SELECT payload FROM outbox WHERE op = 'crdt-update' ORDER BY id")
            .unwrap();
        Ok(s.query_map([], |r| r.get::<_, Vec<u8>>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect())
    })
    .unwrap()
}
fn day_text(db: &Db) -> String {
    let blobs: Vec<Vec<u8>> = db
        .call_blocking(|c| {
            let p = update_log::load_plan(c, DAY_ID).unwrap();
            Ok(p.blobs().into_iter().map(<[u8]>::to_vec).collect())
        })
        .unwrap();
    let r = DocumentRegistry::new("reader", Arc::new(|_, _| {}))
        .get_or_open(DAY_ID)
        .unwrap();
    for b in &blobs {
        r.apply_durable_update(b).unwrap();
    }
    extract_text(&r).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_feed_body_fetched_across_a_revive_is_owed_not_landed() {
    let other = scratch("other");
    other
        .call_blocking(|c| {
            write_day(c, "Deleted words.", "b-old", "device-a", 1);
            Ok(())
        })
        .unwrap();
    let old = queued(&other);

    let db = scratch("feed");
    db.call_blocking(|c| {
        write_day(c, "Local words.", "b-local", "device-b", 1);
        c.execute("DELETE FROM outbox", []).unwrap();
        store::write_cursor(c, RECORD_CURSOR_SCOPE, Some("10"), 1)?;
        for (k, v) in [
            (
                META_RECORD_DECLARATION,
                Declaration::subscribed().header_value(),
            ),
            (META_CURSOR_SKIP_REPAIR, "done".into()),
            (META_NOTE_BODY_LEGACY_PULL, "done".into()),
        ] {
            c.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [k, v.as_str()],
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();

    let revive: Interleave = Box::new(|db| {
        db.call_blocking(|c| {
            assert!(journal::delete_day(c, DAY, "device-b", 2).unwrap());
            c.execute("DELETE FROM outbox", []).unwrap();
            write_day(c, "Back again.", "b-new", "device-b", 3);
            Ok(())
        })
        .unwrap();
    });
    let page = json!({ "items": [], "deleted": [], "hasMore": false, "nextCursor": 11,
        "noteBodies": [{ "op": "update", "noteId": DAY_ID, "cursor": 11, "sequenceNum": 1,
            "signerDeviceId": "device-a", "createdAt": 1_760_000_000, "size": 10, "data": BASE64.encode(&old[0]) }] }).to_string();
    let http = HttpClient::new(
        FakeTransport::new(vec![response(200, &page)]),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    );
    let report = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NoRecords),
    )
    .with_note_bodies(Arc::new(Interleaving {
        db: db.clone(),
        hook: Mutex::new(Some(revive)),
    }))
    .pull_page()
    .await
    .unwrap();
    assert!(report.advanced_documents.is_empty(), "{report:?}");
    let text = day_text(&db);
    assert!(!text.contains("Deleted words."), "{text:?}");
    assert!(text.contains("Back again."), "{text:?}");
    let owed = db
        .call_blocking(|c| memry_core::sync::body_debt::is_owed(c, DAY_ID))
        .unwrap();
    assert!(owed, "the revived day owes a pull of its new body");
    db.call_blocking(|c| {
        write_day(c, "And more.", "b-more", "device-b", 4);
        Ok(())
    })
    .unwrap();
    let fresh = yrs::Doc::new();
    let mut txn = fresh.transact_mut();
    for u in queued(&db) {
        txn.apply_update(Update::decode_v1(&u).unwrap()).unwrap();
    }
    assert!(
        txn.store().pending_update().is_none(),
        "a fresh device integrates every update pushed after the revive"
    );
}
