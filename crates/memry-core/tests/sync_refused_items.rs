//! The refused-items ledger (#4453, chapter 13 §13.2 rule 5), through the real
//! pull: a record this build's schema refuses is recorded by type, id and the
//! app version the host passed, the local row is left as it was, and the
//! record is refetched only once another app version runs.
//!
//! Real `HttpClient`, SQLite and repositories; the transport and the record
//! cipher are the only fakes. A later build that accepts the shape is played
//! by the refetch answering with a payload this build's schema accepts.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::{FakeTransport, response};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullLoop, PullReport, RecordCipher};
use memry_core::sync::refused_items::{self, RefusedItem};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use rusqlite::types::Value as SqlValue;
use serde_json::{Value as Json, json};

const TYPE: &str = "sticky_draft";
const NOW: i64 = 1_776_297_600_000;

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-refused-items-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Opens every envelope to one payload.
struct OnePayload(String);

impl RecordCipher for OnePayload {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0.as_bytes().to_vec())
    }
}

fn envelope(id: &str) -> Json {
    json!({
        "id": id, "type": TYPE, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
    })
}

fn changes(refs: &[&str], next_cursor: &str) -> String {
    let items: Vec<Json> = refs
        .iter()
        .map(|id| json!({"id": id, "type": TYPE}))
        .collect();
    json!({"items": items, "deleted": [], "hasMore": false, "nextCursor": next_cursor}).to_string()
}

fn pulled(ids: &[&str]) -> String {
    json!({ "items": ids.iter().map(|id| envelope(id)).collect::<Vec<_>>() }).to_string()
}

/// One run's first page as app `version`, every record opened to `payload`.
async fn run(
    db: &Db,
    version: &str,
    payload: &Json,
    script: Vec<String>,
) -> (PullReport, Arc<FakeTransport>) {
    let transport = FakeTransport::new(script.iter().map(|body| response(200, body)).collect());
    let http = HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", version).expect("a valid identity"),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::declare(&["note", TYPE]).expect("recognised"),
        Arc::new(OnePayload(payload.to_string())),
    );
    let report = pull.pull_first_page().await.expect("the page");
    (report, transport)
}

/// A draft written on this device, as the user typed it.
fn local_draft(db: &Db) -> String {
    db.call_blocking(|conn| {
        sticky_draft::upsert(conn, None, "mine", StickyKind::Note, "device-a", NOW)
    })
    .expect("a local draft")
    .id
}

/// The whole `sync_items` row and the outbox depth of `id`.
fn local_state(db: &Db, id: &str) -> (Vec<SqlValue>, i64) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        let mut statement = conn
            .prepare("SELECT * FROM sync_items WHERE item_type = ?1 AND item_id = ?2")
            .expect("prepare");
        let width = statement.column_count();
        let row = statement
            .query_row([TYPE, id.as_str()], |row| {
                (0..width).map(|index| row.get(index)).collect()
            })
            .expect("the row");
        let queued = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .expect("count");
        Ok((row, queued))
    })
    .expect("read")
}

fn ledger(db: &Db) -> Vec<RefusedItem> {
    db.call_blocking(|conn| refused_items::entries(conn))
        .expect("ledger")
}

fn entry(id: &str, version: &str) -> RefusedItem {
    RefusedItem {
        item_type: TYPE.to_owned(),
        item_id: id.to_owned(),
        refused_by_version: version.to_owned(),
    }
}

/// A newer peer's shape: `content: null` fails desktop's schema
/// (`packages/contracts/src/sync-payloads.ts:494-500`), under a clock that
/// would otherwise win.
fn refused_shape() -> Json {
    json!({"content": null, "kind": "note", "clock": {"device-a": 1, "peer": 1}})
}

fn content(db: &Db, id: &str) -> String {
    let id = id.to_owned();
    db.call_blocking(move |conn| sticky_draft::get(conn, &id))
        .expect("read")
        .expect("the draft")
        .content
}

/// Pulls the refused shape over a local draft as app 1.0.0.
async fn refuse_once(db: &Db) -> String {
    let id = local_draft(db);
    let script = vec![changes(&[&id], "10"), pulled(&[&id])];
    let (report, _) = run(db, "1.0.0", &refused_shape(), script).await;
    assert_eq!((report.applied, report.corrupt), (0, 0));
    id
}

#[tokio::test]
async fn a_refused_record_is_ledgered_and_the_local_row_is_untouched() {
    let db = scratch_db();
    let id = local_draft(&db);
    let before = local_state(&db, &id);

    let script = vec![changes(&[&id], "10"), pulled(&[&id])];
    let (report, _) = run(&db, "1.0.0", &refused_shape(), script).await;

    assert_eq!((report.applied, report.corrupt), (0, 0));
    assert_eq!(ledger(&db), vec![entry(&id, "1.0.0")]);
    assert_eq!(
        local_state(&db, &id),
        before,
        "the local row is never touched"
    );
    assert_eq!(content(&db, &id), "mine");
    let cursor = db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE));
    assert_eq!(cursor.expect("cursor").as_deref(), Some("10"));
}

#[tokio::test]
async fn the_same_app_version_does_not_refetch_a_refused_record() {
    let db = scratch_db();
    let id = refuse_once(&db).await;
    let before = local_state(&db, &id);

    let (_, transport) = run(&db, "1.0.0", &refused_shape(), vec![changes(&[], "11")]).await;

    assert!(transport.calls_to("/sync/pull").is_empty(), "no refetch");
    assert_eq!(ledger(&db), vec![entry(&id, "1.0.0")]);
    assert_eq!(local_state(&db, &id), before);
}

#[tokio::test]
async fn a_new_app_version_refetches_and_applies_what_it_now_accepts() {
    let db = scratch_db();
    let id = refuse_once(&db).await;
    let accepted = json!({
        "content": "from the peer", "kind": "note", "clock": {"device-a": 1, "peer": 1},
    });

    let script = vec![pulled(&[&id]), changes(&[], "11")];
    let (_, transport) = run(&db, "1.1.0", &accepted, script).await;

    let refetch = transport.calls_to("/sync/pull");
    assert_eq!(refetch.len(), 1);
    let body: Json =
        serde_json::from_slice(refetch[0].body.as_deref().expect("a body")).expect("json");
    assert_eq!(body, json!({ "itemIds": [id] }));
    assert_eq!(content(&db, &id), "from the peer");
    assert!(ledger(&db).is_empty(), "the applied record is resolved");
}

#[tokio::test]
async fn a_new_app_version_that_still_refuses_records_itself() {
    let db = scratch_db();
    let id = refuse_once(&db).await;
    let before = local_state(&db, &id);

    let script = vec![pulled(&[&id]), changes(&[], "11")];
    run(&db, "1.1.0", &refused_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, "1.1.0")]);
    assert_eq!(local_state(&db, &id), before);
}

#[tokio::test]
async fn a_refetch_the_server_answers_without_the_record_resolves_it() {
    let db = scratch_db();
    refuse_once(&db).await;

    run(
        &db,
        "1.1.0",
        &refused_shape(),
        vec![pulled(&[]), changes(&[], "11")],
    )
    .await;

    assert!(ledger(&db).is_empty());
}

#[tokio::test]
async fn a_refetch_answered_with_no_pull_envelope_keeps_the_entry() {
    let db = scratch_db();
    let id = refuse_once(&db).await;

    let script = vec![json!({"error": "bad"}).to_string(), changes(&[], "11")];
    run(&db, "1.1.0", &refused_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, "1.0.0")]);
}
