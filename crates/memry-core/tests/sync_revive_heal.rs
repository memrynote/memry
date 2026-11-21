//! #5354: a journal day deleted and written again on a build before #5351
//! authored its new text on the deleted body. The server purged that body
//! (§7.15), so it holds only the new update, and every fresh device keeps it
//! pending and shows the day empty. The author re-pushes its full state once,
//! and a fresh device then reads the day: the old text and the new text.
mod http_fakes;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::body_edit::{self, BlockEdit};
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::domain::journal;
use memry_core::domain::journal_ops::body;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::revive_heal;
use rusqlite::Connection;
use serde_json::json;

const DAY: &str = "2099-06-15";
const DAY_ID: &str = "j2099-06-15";

struct PassThrough;
impl CrdtCipher for PassThrough {
    fn open(&self, u: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(u.packed.to_vec())
    }
}

fn scratch(label: &str) -> Db {
    let dir =
        std::env::temp_dir().join(format!("memry-revive-heal-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    open_data(&dir.join("data.db")).unwrap()
}

fn queued(conn: &Connection) -> Vec<Vec<u8>> {
    let mut s = conn
        .prepare("SELECT payload FROM outbox WHERE op = 'crdt-update' ORDER BY id")
        .unwrap();
    s.query_map([], |r| r.get::<_, Vec<u8>>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// The revive of a build before #5351: the tombstone cleared and the edit
/// authored on the deleted body, under the device's own client id.
fn shipped_revive(conn: &mut Connection, text: &str) -> Vec<u8> {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    let doc = DocumentRegistry::new(
        "device-b",
        Arc::new(move |_, bytes: &[u8]| sink.lock().unwrap().push(bytes.to_vec())),
    )
    .get_or_open(DAY_ID)
    .unwrap();
    for blob in update_log::load_plan(conn, DAY_ID).unwrap().blobs() {
        doc.apply_durable_update(blob).unwrap();
    }
    body_edit::apply(
        &doc,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: text.into(),
            new_block_id: "b-new".into(),
        },
    )
    .unwrap();
    let update = captured.lock().unwrap().concat();
    assert_eq!(captured.lock().unwrap().len(), 1);
    update_log::append_local_update(conn, DAY_ID, &update, 3).unwrap();
    conn.execute(
        "UPDATE sync_items SET deleted_at = NULL WHERE item_id = ?1",
        [DAY_ID],
    )
    .unwrap();
    update
}

/// Device B writes the day, pushes it (server seq 1), deletes it (the server
/// purges seq 1), and revives it as a shipped build did (server seq 2).
/// Answers the two server updates.
fn author(db: &Db) -> (Vec<u8>, Vec<u8>) {
    db.call_blocking(|c| {
        let edit = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "Deleted words.".into(),
            new_block_id: "b-old".into(),
        };
        body::edit_day(c, DAY, &edit, "device-b", 1).unwrap();
        let old = queued(c).concat();
        assert!(journal::delete_day(c, DAY, "device-b", 2).unwrap());
        c.execute("DELETE FROM outbox", []).unwrap();
        Ok((old, shipped_revive(c, "Back again.")))
    })
    .unwrap()
}

fn server(updates: &[(i64, &[u8])]) -> Arc<FakeTransport> {
    let entries: Vec<_> = updates
        .iter()
        .map(|(seq, data)| {
            json!({ "sequenceNum": seq, "data": BASE64.encode(data),
                    "signerDeviceId": "device-b", "createdAt": 1_760_000_000 })
        })
        .collect();
    FakeTransport::new(vec![
        response(200, &json!({ "snapshot": null }).to_string()),
        response(
            200,
            &json!({ "updates": entries, "hasMore": false }).to_string(),
        ),
    ])
}

fn body_pull(db: &Db, transport: Arc<FakeTransport>) -> BodyPull {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").unwrap(),
    );
    BodyPull::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    )
}

/// What a device that bootstraps now reads: every server row, then whatever
/// the author queued for the server.
fn fresh_device(server_rows: &[&[u8]], queued: &[Vec<u8>]) -> (String, bool) {
    let doc = DocumentRegistry::new("fresh", Arc::new(|_, _| {}))
        .get_or_open(DAY_ID)
        .unwrap();
    for blob in server_rows.iter().copied().chain(queued.iter().map(Vec::as_slice)) {
        doc.apply_durable_update(blob).unwrap();
    }
    (extract_text(&doc).unwrap(), doc.has_missing_updates().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_day_revived_on_a_shipped_build_is_re_pushed_whole_once() {
    let db = scratch("heal");
    let (_purged, new) = author(&db);
    let (text, pending) = fresh_device(&[&new], &[]);
    assert!(pending && text.is_empty(), "the #5351 shape: {text:?}");

    let transport = server(&[(2, &new)]);
    let healed = revive_heal::run(&db, &body_pull(&db, Arc::clone(&transport)))
        .await
        .unwrap();
    assert_eq!(healed, 1);

    let pushed = db.call_blocking(|c| Ok(queued(c))).unwrap();
    let (text, pending) = fresh_device(&[&new], &pushed);
    assert!(!pending, "a fresh device integrates the healed body");
    assert!(text.contains("Back again."), "{text:?}");
    assert!(text.contains("Deleted words."), "accepted: {text:?}");

    // Once per document: the next pass sends nothing and queues nothing.
    db.call_blocking(|c| {
        c.execute("DELETE FROM outbox", []).unwrap();
        Ok(())
    })
    .unwrap();
    let idle = FakeTransport::new(vec![]);
    let again = revive_heal::run(&db, &body_pull(&db, Arc::clone(&idle)))
        .await
        .unwrap();
    assert_eq!(again, 0);
    assert_eq!(idle.call_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revived_day_whose_server_body_applies_is_not_pushed() {
    let db = scratch("healthy");
    // A server before #2986 kept the deleted body: the new update applies.
    let (old, new) = author(&db);
    let transport = server(&[(1, &old), (2, &new)]);
    let healed = revive_heal::run(&db, &body_pull(&db, transport))
        .await
        .unwrap();
    assert_eq!(healed, 0);
    assert!(db.call_blocking(|c| Ok(queued(c))).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revived_day_with_an_unpushed_update_waits_for_its_push() {
    let db = scratch("unpushed");
    author(&db);
    db.call_blocking(|c| {
        c.execute(
            "INSERT INTO outbox (item_type, item_id, op, payload, enqueued_at)
             VALUES ('journal', ?1, 'upsert', NULL, 3)",
            [DAY_ID],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let idle = FakeTransport::new(vec![]);
    let healed = revive_heal::run(&db, &body_pull(&db, Arc::clone(&idle)))
        .await
        .unwrap();
    assert_eq!(healed, 0);
    assert_eq!(idle.call_count(), 0, "judged only after the push");
}

#[test]
fn a_day_revived_after_5351_is_no_candidate() {
    let db = scratch("fixed");
    db.call_blocking(|c| {
        let edit = |text: &str, block: &str| BlockEdit::InsertParagraph {
            after_block_id: None,
            text: text.into(),
            new_block_id: block.into(),
        };
        body::edit_day(c, DAY, &edit("Old.", "b-old"), "device-b", 1).unwrap();
        assert!(journal::delete_day(c, DAY, "device-b", 2).unwrap());
        body::edit_day(c, DAY, &edit("New.", "b-new"), "device-b", 3).unwrap();
        c.execute("DELETE FROM outbox", []).unwrap();
        assert!(revive_heal::candidates(c).unwrap().is_empty());
        Ok(())
    })
    .unwrap();
}
