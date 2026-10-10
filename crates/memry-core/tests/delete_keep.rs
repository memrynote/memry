//! A pulled journal delete over text this device never sent keeps that text
//! as an inbox note first (#3029, chapter 05 §5.8 client behavior).
//!
//! Real `PullLoop`, `HttpClient`, SQLite, update log, outbox and `yrs`. The
//! transport and the record cipher are fakes; a tombstone's body is never
//! decoded, so a cipher that opens nothing is enough.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::update_log;
use memry_core::domain::body_write;
use memry_core::domain::journal_ops::body;
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use rusqlite::Connection;
use serde_json::{Value as Json, json};
use yrs::XmlTextPrelim;
use yrs::{Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _};

const DATE: &str = "2026-10-09";
const DAY: &str = "j2026-10-09";
const DEVICE: &str = "device-core";
/// The deleting device's time, in ms as the core sends it.
const DELETED_AT: i64 = 1_791_547_200_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-delete-keep-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct NeverOpens;

impl RecordCipher for NeverOpens {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// One real pull page carrying the other device's delete of the day.
async fn deliver_the_delete(db: &Db, clock: Json) {
    deliver_a_delete(db, "journal", DAY, clock).await;
}

async fn deliver_a_delete(db: &Db, item_type: &str, item_id: &str, clock: Json) {
    let tombstone = json!({
        "id": item_id,
        "type": item_type,
        "operation": "delete",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-desktop",
        "deletedAt": DELETED_AT,
        "clock": clock,
    });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": item_id, "type": item_type}], "deleted": [], "hasMore": false, "nextCursor": "9"})
                .to_string(),
        ),
        response(200, &json!({ "items": [tombstone] }).to_string()),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let report = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(NeverOpens),
    )
    .with_clock_device(DEVICE)
    .pull_page()
    .await
    .expect("the page");
    assert!(!report.refused);
}

fn type_on_the_day(conn: &Connection, text: &str, now_ms: i64) {
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_owned(),
        new_block_id: "b1".to_owned(),
    };
    body::edit_day(conn, DATE, &edit, DEVICE, now_ms).expect("the edit");
}

/// Every live inbox capture as `(title, content)`, and its queued pushes.
fn inbox(conn: &Connection) -> (Vec<(String, String)>, i64) {
    let mut statement = conn
        .prepare("SELECT payload FROM sync_items WHERE item_type = 'inbox' AND deleted_at IS NULL")
        .expect("prepare");
    let items = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|payload| {
            let payload: Json = serde_json::from_str(&payload.expect("row")).expect("json");
            (
                payload["title"].as_str().unwrap_or_default().to_owned(),
                payload["content"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let queued = conn
        .query_row(
            "SELECT count(*) FROM outbox WHERE item_type = 'inbox' AND op = 'upsert'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    (items, queued)
}

fn day_is_deleted(conn: &Connection) -> bool {
    sync_items::load(conn, "journal", DAY)
        .expect("load")
        .is_some_and(|row| row.deleted_at.is_some())
        && update_log::load_plan(conn, DAY).expect("plan").is_empty()
}

const KEPT_TITLE: &str = "Journal 2026-10-09 (kept from deleted day)";

#[tokio::test]
async fn a_day_typed_offline_is_kept_in_the_inbox_and_then_deleted() {
    let db = scratch_db("offline");
    db.call_blocking(|conn| {
        type_on_the_day(conn, "Typed on the plane", DELETED_AT - 3_600_000);
        Ok(())
    })
    .expect("seed");

    deliver_the_delete(&db, json!({"device-desktop": 5})).await;

    db.call_blocking(|conn| {
        assert_eq!(
            inbox(conn),
            (
                vec![(KEPT_TITLE.to_owned(), "Typed on the plane".to_owned())],
                1
            )
        );
        assert!(day_is_deleted(conn));
        Ok(())
    })
    .expect("check");
}

#[tokio::test]
async fn an_edit_pushed_in_an_earlier_pass_but_made_after_the_delete_is_kept() {
    let db = scratch_db("pushed");
    db.call_blocking(|conn| {
        type_on_the_day(conn, "Written after the delete", DELETED_AT + 5_000);
        // The pass that pushed it acknowledged every row.
        conn.execute("DELETE FROM outbox", []).expect("ack");
        Ok(())
    })
    .expect("seed");

    // The tombstone covers this device's record clock: only the edit time tells.
    deliver_the_delete(&db, json!({"device-desktop": 5, DEVICE: 1})).await;

    db.call_blocking(|conn| {
        assert_eq!(inbox(conn).0.len(), 1);
        assert!(day_is_deleted(conn));
        Ok(())
    })
    .expect("check");
}

#[tokio::test]
async fn text_the_deleting_device_already_had_is_not_kept() {
    let db = scratch_db("synced");
    db.call_blocking(|conn| {
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: "journal".to_owned(),
                item_id: DAY.to_owned(),
                payload_json: json!({"date": DATE, "clock": {"device-desktop": 4}}).to_string(),
                server_cursor: Some(3),
                signer_device_id: Some("device-desktop".to_owned()),
                updated_at: DELETED_AT - 3_600_000,
                deleted_at: None,
            },
            DELETED_AT - 3_600_000,
        )?;
        update_log::append_server_update(conn, DAY, 1, &server_paragraph("Old news"), 1)
            .expect("server body");
        Ok(())
    })
    .expect("seed");

    deliver_the_delete(&db, json!({"device-desktop": 5})).await;

    db.call_blocking(|conn| {
        assert_eq!(inbox(conn), (vec![], 0));
        assert!(day_is_deleted(conn));
        Ok(())
    })
    .expect("check");
}

#[tokio::test]
async fn the_same_delete_twice_keeps_one_copy() {
    let db = scratch_db("twice");
    db.call_blocking(|conn| {
        type_on_the_day(conn, "Only once", DELETED_AT - 3_600_000);
        Ok(())
    })
    .expect("seed");

    deliver_the_delete(&db, json!({"device-desktop": 5})).await;
    deliver_the_delete(&db, json!({"device-desktop": 5})).await;

    db.call_blocking(|conn| {
        assert_eq!(
            inbox(conn).0,
            vec![(KEPT_TITLE.to_owned(), "Only once".to_owned())]
        );
        Ok(())
    })
    .expect("check");
}

#[tokio::test]
async fn a_note_edited_offline_is_kept_under_its_title() {
    const NOTE: &str = "abc123def456";
    let db = scratch_db("note");
    db.call_blocking(|conn| {
        notes::create(
            conn,
            &NewNote {
                id: NOTE,
                title: "Plans",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            DELETED_AT - 7_200_000,
        )?;
        let edit = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "Edited offline".to_owned(),
            new_block_id: "b1".to_owned(),
        };
        body_write::edit_block(conn, NOTE, &edit, DEVICE, DELETED_AT - 3_600_000)
            .expect("the edit");
        Ok(())
    })
    .expect("seed");

    deliver_a_delete(&db, "note", NOTE, json!({"device-desktop": 5})).await;

    db.call_blocking(|conn| {
        assert_eq!(
            inbox(conn).0,
            vec![(
                "Plans (kept from deleted note)".to_owned(),
                "Edited offline".to_owned()
            )]
        );
        Ok(())
    })
    .expect("check");
}

/// A one-paragraph body authored elsewhere, as a server update.
fn server_paragraph(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", "s1");
    let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
    paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}
