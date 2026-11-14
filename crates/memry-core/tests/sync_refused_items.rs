//! The refused-items ledger (#4453, chapter 13 §13.2 rule 5), through the real
//! pull: a record this build's schema refuses is recorded by type, id and the
//! core build that refused it, the local row is left as it was, and the
//! record is refetched only once another core build runs.
//!
//! Real `HttpClient`, SQLite and repositories; the transport and the record
//! cipher are the only fakes. An entry an older build left is played by
//! re-stamping the ledger row ([`as_older_build`]), and a later build that
//! accepts the shape by the refetch answering with a payload this build's
//! schema accepts.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::{FakeTransport, response};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::{PullError, PullLoop, PullReport, RecordCipher};
use memry_core::sync::refused_items::{self, CORE_BUILD, RefusedItem};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use rusqlite::types::Value as SqlValue;
use serde_json::{Value as Json, json};

const TYPE: &str = "sticky_draft";
const NOW: i64 = 1_776_297_600_000;
const OLDER_BUILD: &str = "0.0.1+older";

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

fn envelope_of(item_type: &str, id: &str) -> Json {
    json!({
        "id": id, "type": item_type, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
    })
}

fn changes_of(refs: &[(&str, &str)], deleted: &[&str], next_cursor: &str) -> String {
    let items: Vec<Json> = refs
        .iter()
        .map(|(item_type, id)| json!({"id": id, "type": item_type}))
        .collect();
    json!({"items": items, "deleted": deleted, "hasMore": false, "nextCursor": next_cursor})
        .to_string()
}

fn changes(refs: &[&str], next_cursor: &str) -> String {
    let refs: Vec<(&str, &str)> = refs.iter().map(|id| (TYPE, *id)).collect();
    changes_of(&refs, &[], next_cursor)
}

fn pulled_items(items: Vec<Json>) -> String {
    json!({ "items": items }).to_string()
}

fn pulled(ids: &[&str]) -> String {
    pulled_items(ids.iter().map(|id| envelope_of(TYPE, id)).collect())
}

/// One run's first page under the `x-memry-client` app `version`, every
/// record opened to `payload`.
async fn try_run(
    db: &Db,
    version: &str,
    payload: &Json,
    script: Vec<(u16, String)>,
) -> (Result<PullReport, PullError>, Arc<FakeTransport>) {
    let transport = FakeTransport::new(
        script
            .iter()
            .map(|(status, body)| response(*status, body))
            .collect(),
    );
    let http = HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", version).expect("a valid identity"),
    );
    let declared = [
        "note",
        TYPE,
        "home_page",
        "canvas",
        "vault_lock",
        "task_activity",
    ];
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::declare(&declared).expect("recognised"),
        Arc::new(OnePayload(payload.to_string())),
    );
    (pull.pull_first_page().await, transport)
}

async fn run(
    db: &Db,
    version: &str,
    payload: &Json,
    script: Vec<String>,
) -> (PullReport, Arc<FakeTransport>) {
    let script = script.into_iter().map(|body| (200, body)).collect();
    let (report, transport) = try_run(db, version, payload, script).await;
    (report.expect("the page"), transport)
}

/// A draft written on this device, as the user typed it.
fn local_draft(db: &Db) -> String {
    db.call_blocking(|conn| {
        sticky_draft::upsert(conn, None, "mine", StickyKind::Note, "device-a", NOW)
    })
    .expect("a local draft")
    .id
}

/// The whole `sync_items` rows and the outbox depth of `id`.
fn local_state(db: &Db, id: &str) -> (Vec<Vec<SqlValue>>, i64) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        let mut statement = conn
            .prepare("SELECT * FROM sync_items WHERE item_id = ?1 ORDER BY item_type")
            .expect("prepare");
        let width = statement.column_count();
        let rows = statement
            .query_map([id.as_str()], |row| {
                (0..width).map(|index| row.get(index)).collect()
            })
            .expect("the rows")
            .collect::<Result<Vec<Vec<SqlValue>>, _>>()
            .expect("read rows");
        let queued = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .expect("count");
        Ok((rows, queued))
    })
    .expect("read")
}

fn ledger(db: &Db) -> Vec<RefusedItem> {
    db.call_blocking(|conn| refused_items::entries(conn))
        .expect("ledger")
}

fn entry_of(item_type: &str, id: &str, build: &str) -> RefusedItem {
    RefusedItem {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        refused_by_version: build.to_owned(),
    }
}

fn entry(id: &str, build: &str) -> RefusedItem {
    entry_of(TYPE, id, build)
}

/// Plays an entry an older core build left behind, past the retry cooldown.
fn as_older_build(db: &Db) {
    db.call_blocking(|conn| {
        conn.execute(
            "UPDATE sync_refused_items SET refused_by_version = ?1, refused_at = 0",
            [OLDER_BUILD],
        )
        .expect("re-stamp");
        Ok(())
    })
    .expect("write");
}

/// An entry an older core build left for an item with no local row.
fn seed_older_entry(db: &Db, item_type: &str, id: &str) {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
             VALUES (?1, ?2, ?3, 0)",
            [item_type.as_str(), id.as_str(), OLDER_BUILD],
        )
        .expect("seed");
        Ok(())
    })
    .expect("write");
}

fn cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("cursor")
}

/// A newer peer's shape: `content: null` fails desktop's schema
/// (`packages/contracts/src/sync-payloads.ts:494-500`), under a clock that
/// would otherwise win.
fn refused_shape() -> Json {
    json!({"content": null, "kind": "note", "clock": {"device-a": 1, "peer": 1}})
}

fn accepted_shape() -> Json {
    json!({"content": "from the peer", "kind": "note", "clock": {"device-a": 1, "peer": 1}})
}

fn content(db: &Db, id: &str) -> String {
    let id = id.to_owned();
    db.call_blocking(move |conn| sticky_draft::get(conn, &id))
        .expect("read")
        .expect("the draft")
        .content
}

/// Pulls the refused shape over a local draft as app 1.0.0, then plays the
/// entry as an older core build's.
async fn refused_by_older_build(db: &Db) -> String {
    let id = local_draft(db);
    let script = vec![changes(&[&id], "10"), pulled(&[&id])];
    let (report, _) = run(db, "1.0.0", &refused_shape(), script).await;
    assert_eq!((report.applied, report.corrupt), (0, 0));
    as_older_build(db);
    id
}

#[tokio::test]
async fn a_refused_record_is_ledgered_under_the_core_build_and_the_local_row_is_untouched() {
    let db = scratch_db();
    let id = local_draft(&db);
    let before = local_state(&db, &id);

    let script = vec![changes(&[&id], "10"), pulled(&[&id])];
    let (report, _) = run(&db, "1.0.0", &refused_shape(), script).await;

    assert_eq!((report.applied, report.corrupt), (0, 0));
    assert_eq!(ledger(&db), vec![entry(&id, CORE_BUILD)]);
    assert_eq!(
        local_state(&db, &id),
        before,
        "the local row is never touched"
    );
    assert_eq!(content(&db, &id), "mine");
    assert_eq!(cursor(&db).as_deref(), Some("10"));
}

/// iOS reports the same marketing version on every TestFlight build, so the
/// app version the host passes cannot key the ledger (#4453 review item 1).
#[tokio::test]
async fn the_same_core_build_does_not_refetch_under_a_new_app_version() {
    let db = scratch_db();
    let id = local_draft(&db);
    run(
        &db,
        "1.0.0",
        &refused_shape(),
        vec![changes(&[&id], "10"), pulled(&[&id])],
    )
    .await;
    let before = local_state(&db, &id);

    let (_, transport) = run(&db, "1.1.0", &refused_shape(), vec![changes(&[], "11")]).await;

    assert!(transport.calls_to("/sync/pull").is_empty(), "no refetch");
    assert_eq!(ledger(&db), vec![entry(&id, CORE_BUILD)]);
    assert_eq!(local_state(&db, &id), before);
}

#[tokio::test]
async fn a_new_core_build_under_the_same_app_version_refetches_and_applies() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;

    let script = vec![pulled(&[&id]), changes(&[], "11")];
    let (_, transport) = run(&db, "1.0.0", &accepted_shape(), script).await;

    let refetch = transport.calls_to("/sync/pull");
    assert_eq!(refetch.len(), 1);
    let body: Json =
        serde_json::from_slice(refetch[0].body.as_deref().expect("a body")).expect("json");
    assert_eq!(body, json!({ "itemIds": [id] }));
    assert_eq!(content(&db, &id), "from the peer");
    assert!(ledger(&db).is_empty(), "the applied record is resolved");
}

#[tokio::test]
async fn a_new_core_build_that_still_refuses_records_itself() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;
    let before = local_state(&db, &id);

    let script = vec![pulled(&[&id]), changes(&[], "11")];
    run(&db, "1.0.0", &refused_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, CORE_BUILD)]);
    assert_eq!(local_state(&db, &id), before);
}

#[tokio::test]
async fn a_refetch_the_server_answers_without_the_record_resolves_it() {
    let db = scratch_db();
    refused_by_older_build(&db).await;

    let script = vec![pulled(&[]), changes(&[], "11")];
    run(&db, "1.0.0", &refused_shape(), script).await;

    assert!(ledger(&db).is_empty());
}

#[tokio::test]
async fn a_refetch_answered_with_no_pull_envelope_keeps_the_entry() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;

    let script = vec![json!({"error": "bad"}).to_string(), changes(&[], "11")];
    run(&db, "1.0.0", &refused_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, OLDER_BUILD)]);
}

/// Review item 2: a failed refetch is logged and the pass goes on to the feed.
#[tokio::test]
async fn a_failed_refetch_keeps_the_entry_and_the_page_is_still_pulled() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;

    let error = json!({"error": {"code": "BAD_REQUEST", "message": "no"}}).to_string();
    let script = vec![(400, error), (200, changes(&[], "11"))];
    let (report, _) = try_run(&db, "1.0.0", &refused_shape(), script).await;

    assert!(report.is_ok(), "the run goes on: {report:?}");
    assert_eq!(cursor(&db).as_deref(), Some("11"), "the feed page is read");
    assert_eq!(ledger(&db), vec![entry(&id, OLDER_BUILD)]);
}

/// Review item 3: the server did return the record, but it does not decode.
/// The entry stays, and the good local row is not flagged corrupt.
#[tokio::test]
async fn a_refetched_record_that_does_not_decode_stays_ledgered() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;
    let before = local_state(&db, &id);

    let malformed = json!({"id": id, "type": TYPE});
    let script = vec![pulled_items(vec![malformed]), changes(&[], "11")];
    run(&db, "1.0.0", &accepted_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, OLDER_BUILD)]);
    assert_eq!(local_state(&db, &id), before, "no corrupt flag");
}

/// VERIFY-4453 item 1: a kept entry waits out desktop's one-hour cooldown
/// (`schema-invalid-ledger.ts:88-90`) instead of a refetch on every pass.
#[tokio::test]
async fn a_kept_entry_is_refetched_once_across_two_passes() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;

    let malformed = json!({"id": id, "type": TYPE});
    let script = vec![pulled_items(vec![malformed]), changes(&[], "11")];
    let (_, first) = run(&db, "1.0.0", &accepted_shape(), script).await;
    let (_, second) = run(&db, "1.0.0", &accepted_shape(), vec![changes(&[], "12")]).await;

    assert_eq!(first.calls_to("/sync/pull").len(), 1);
    assert!(second.calls_to("/sync/pull").is_empty(), "cooling down");
    assert_eq!(ledger(&db), vec![entry(&id, OLDER_BUILD)]);
}

/// VERIFY-4453 item 7: a refetched record that applies corrupt keeps its
/// entry for a later build.
#[tokio::test]
async fn a_refetched_record_that_applies_corrupt_keeps_its_entry() {
    let db = scratch_db();
    seed_older_entry(&db, TYPE, "draft-gone");

    let script = vec![pulled(&["draft-gone"]), changes(&[], "11")];
    run(&db, "1.0.0", &json!("not an object"), script).await;

    assert_eq!(ledger(&db), vec![entry("draft-gone", OLDER_BUILD)]);
}

/// VERIFY-4453 item 1: an expired record is final, so its entry is resolved.
#[tokio::test]
async fn a_refetched_record_that_expired_resolves_its_entry() {
    let db = scratch_db();
    seed_older_entry(&db, "task_activity", "activity-1");

    let old = json!({"taskId": "t", "createdAt": "2000-01-01T00:00:00.000Z", "clock": {"peer": 1}});
    let script = vec![
        pulled_items(vec![envelope_of("task_activity", "activity-1")]),
        changes(&[], "11"),
    ];
    run(&db, "1.0.0", &old, script).await;

    assert!(ledger(&db).is_empty());
}

/// Review item 6: a refetch by id answers every type under it; only the
/// requested `(type, id)` is read.
#[tokio::test]
async fn a_refetch_ignores_another_type_under_the_same_id() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;
    let before = local_state(&db, &id);

    let script = vec![
        pulled_items(vec![envelope_of(TYPE, &id), envelope_of("note", &id)]),
        changes(&[], "11"),
    ];
    run(&db, "1.0.0", &refused_shape(), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, CORE_BUILD)]);
    assert_eq!(local_state(&db, &id), before, "no `note` row appears");
}

/// Review item 4: the clock gate holds on a refetch. A local edit made after
/// the refusal dominates the refetched record, which is skipped and resolved.
#[tokio::test]
async fn a_refetch_the_local_clock_dominates_is_skipped_and_resolved() {
    let db = scratch_db();
    let id = refused_by_older_build(&db).await;
    let edit = id.clone();
    db.call_blocking(move |conn| {
        sticky_draft::upsert(
            conn,
            Some(&edit),
            "mine, edited",
            StickyKind::Note,
            "device-a",
            NOW + 1,
        )
    })
    .expect("a local edit");
    let before = local_state(&db, &id);

    let older = json!({"content": "stale", "kind": "note", "clock": {"device-a": 1}});
    let script = vec![pulled(&[&id]), changes(&[], "11")];
    run(&db, "1.0.0", &older, script).await;

    assert!(ledger(&db).is_empty(), "decided by its clock");
    assert_eq!(local_state(&db, &id), before, "the row is byte-identical");
    assert_eq!(content(&db, &id), "mine, edited");
}

/// Review item 4: a feed page under the same build that applies the record
/// resolves the entry itself, with no refetch.
#[tokio::test]
async fn a_feed_page_that_applies_the_record_resolves_the_entry() {
    let db = scratch_db();
    let id = local_draft(&db);
    run(
        &db,
        "1.0.0",
        &refused_shape(),
        vec![changes(&[&id], "10"), pulled(&[&id])],
    )
    .await;

    let script = vec![changes(&[&id], "11"), pulled(&[&id])];
    run(&db, "1.0.0", &accepted_shape(), script).await;

    assert_eq!(content(&db, &id), "from the peer");
    assert!(ledger(&db).is_empty());
}

/// Review item 5: an id in `deleted` with no type deletes every row under it,
/// and with them every ledger entry.
#[tokio::test]
async fn an_untyped_tombstone_resolves_the_entry() {
    let db = scratch_db();
    let id = local_draft(&db);
    run(
        &db,
        "1.0.0",
        &refused_shape(),
        vec![changes(&[&id], "10"), pulled(&[&id])],
    )
    .await;

    run(
        &db,
        "1.0.0",
        &refused_shape(),
        vec![changes_of(&[], &[&id], "11"), pulled(&[])],
    )
    .await;

    assert!(ledger(&db).is_empty());
}

/// Review item 4 and its closing note: each schema refusal outside
/// `apply_kept` is ledgered, not skipped.
async fn ledgers(item_type: &str, id: &str, payload: Json) {
    let db = scratch_db();
    let script = vec![
        changes_of(&[(item_type, id)], &[], "10"),
        pulled_items(vec![envelope_of(item_type, id)]),
    ];
    run(&db, "1.0.0", &payload, script).await;
    assert_eq!(ledger(&db), vec![entry_of(item_type, id, CORE_BUILD)]);
}

#[tokio::test]
async fn home_page_widgets_that_are_not_text_are_ledgered() {
    let payload = json!({"name": "Home", "widgets": 5, "clock": {"peer": 1}});
    ledgers("home_page", "board-1", payload).await;
}

#[tokio::test]
async fn a_canvas_scene_that_is_not_text_is_ledgered() {
    let payload = json!({"vaultId": "v", "scene": 5, "clock": {"peer": 1}});
    ledgers("canvas", "canvas-1", payload).await;
}

/// `vault_lock` applies only in the desktop build (`src/sync/apply.rs:469`).
#[cfg(feature = "markdown")]
#[tokio::test]
async fn a_vault_lock_target_kind_that_is_not_text_is_ledgered() {
    let payload = json!({"targetKind": 5, "target": "x", "locked": true, "clock": {"peer": 1}});
    ledgers("vault_lock", "lock-1", payload).await;
}

#[tokio::test]
async fn a_live_record_that_is_json_but_not_an_object_is_ledgered() {
    let db = scratch_db();
    let id = local_draft(&db);
    let before = local_state(&db, &id);

    let script = vec![changes(&[&id], "10"), pulled(&[&id])];
    run(&db, "1.0.0", &json!([1, 2]), script).await;

    assert_eq!(ledger(&db), vec![entry(&id, CORE_BUILD)]);
    assert_eq!(local_state(&db, &id), before);
}
