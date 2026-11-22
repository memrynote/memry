//! An edit to an item the server holds deleted (chapter 05 §5.8, #5406).
//!
//! Real `HttpClient`, real SQLite, real pull decode and marker verification.
//! The fake is the `Transport`, scripted in call order: the push answer, then
//! the by-id pull a `SYNC_DELETE_WINS` triggers.
//!
//! | Test                                                   | Rule                  |
//! | ------------------------------------------------------ | --------------------- |
//! | a bare `SYNC_DELETE_WINS` keeps the row                 | §5.8, #5338, #5406    |
//! | delete-wins with an attested marker deletes, records T | §5.8, §5.12.3, #5406  |
//! | delete-wins with a forged marker keeps the row          | §5.12.3, #5406        |
//! | a re-create after the delete is not deleted again       | §5.8 client rule      |
//! | an id two sent items share deletes neither              | §5.12.1, #5406        |
//! | a failed by-id pull defers the item, not the wave       | #5406                 |
//! | an unreadable remembered marker defers, sends nothing   | #5406                 |
//! | an edit over a kept marker deletes and sends none       | §5.12.3, #5406        |
//! | a write newer than the marker pushes normally           | §5.12.3, #5406        |
//! | a local delete forgets the marker                       | §5.8 re-create, #5406 |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::protocol::delete_attestation::{self, DeleteClaim};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::clock::VectorClock;
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use rusqlite::params;
use serde_json::{Value as Json, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-delete-wins-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A live row held at `cursor` with `clock`, edited locally: one upsert queued.
fn edited(db: &Db, item_type: &str, id: &str, cursor: i64, clock: &str) {
    let (item_type, id, clock) = (item_type.to_owned(), id.to_owned(), clock.to_owned());
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     clock, updated_at)
             VALUES (?1, ?2, '{\"title\":\"edited\"}', 'full', ?3, ?4, 1)",
            params![item_type, id, cursor, clock],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert(&item_type, &id), 1, |_| Ok(())).map(|_| ())
    })
    .expect("seed the edited row");
}

fn edited_task(db: &Db, id: &str, cursor: i64) {
    edited(db, "task", id, cursor, r#"{"device-b":3}"#);
}

/// What the first-sync reconcile records for a row it kept against a marker
/// with no attestation: one baseline `meta` row.
fn kept_marker_value(db: &Db, id: &str, value: String) {
    let key = format!("sync.unattested_marker\0task\0{id}");
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(failed)?;
        Ok(())
    })
    .expect("remember the marker");
}

fn kept_marker(db: &Db, id: &str, cursor: i64, clock: Option<Json>) {
    let value = json!({"deletedAt": 1_700_000_000_000i64, "serverCursor": cursor, "clock": clock});
    kept_marker_value(db, id, value.to_string());
}

fn deleted(db: &Db, item_type: &str, id: &str) -> bool {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, id],
            |row| row.get(0),
        )
        .map_err(failed)
    })
    .expect("read the row")
}

fn task_deleted(db: &Db, id: &str) -> bool {
    deleted(db, "task", id)
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.call_blocking(move |conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
        .expect("count")
}

fn remembered(db: &Db) -> i64 {
    count(
        db,
        "SELECT COUNT(*) FROM meta WHERE key LIKE 'sync.unattested_marker%'",
    )
}

struct EchoSealer;

impl PushSealer for EchoSealer {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        Ok(json!({"id": item.row.item_id, "type": item.row.item_type}))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// `device-a`'s Ed25519 key pair.
fn signer() -> (Vec<u8>, Vec<u8>) {
    let (public, secret) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("a key pair");
    (public, secret.to_vec())
}

/// Knows `device-a`'s key; opens nothing (the by-id pulls here carry no item).
struct Directory;

impl RecordCipher for Directory {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }

    fn signing_key(&self, device_id: &str) -> Option<Vec<u8>> {
        (device_id == "device-a").then(|| signer().0)
    }
}

/// The purged marker of task `id` at `cursor`, clock `{device-a: 2}`,
/// attested by `device-a` unless `forged`.
fn marker(id: &str, cursor: i64, forged: bool) -> Json {
    let clock: VectorClock = [("device-a".to_owned(), 2)].into();
    let deleted_at = 1_700_000_000_000i64;
    let claim = DeleteClaim {
        item_type: "task",
        item_id: id,
        clock: &clock,
        deleted_at: if forged { deleted_at + 1 } else { deleted_at },
    };
    let attestation = delete_attestation::sign(&claim, &signer().1).expect("signed");
    json!({"id": id, "type": "task", "deletedAt": deleted_at, "clock": clock,
           "serverCursor": cursor, "signerDeviceId": "device-a",
           "deleteAttestation": attestation})
}

fn pull_answer(markers: Vec<Json>) -> String {
    json!({"items": [], "deleted": [], "purgedTombstones": markers, "hasMore": false,
           "nextCursor": 0})
    .to_string()
}

fn coordinator(db: &Db, transport: Arc<FakeTransport>) -> PushCoordinator {
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let pull = PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory),
    )
    .with_clock_device("device-b");
    PushCoordinator::new(
        http,
        db.clone(),
        Declaration::subscribed(),
        Arc::new(EchoSealer),
        "device-b",
    )
    .with_pull(Arc::new(pull))
}

fn push_answer(accepted: &[&str], rejected: &[(&str, &str)]) -> String {
    let rejected: Vec<Json> = rejected
        .iter()
        .map(|(id, reason)| json!({"id": id, "reason": reason}))
        .collect();
    json!({"accepted": accepted, "rejected": rejected, "serverTime": 1, "maxCursor": 1}).to_string()
}

fn delete_wins(id: &str) -> String {
    push_answer(&[], &[(id, "SYNC_DELETE_WINS")])
}

/// #5338's invariant: a bare server string deletes nothing. The by-id pull
/// finds no signed delete and no marker, so the row stays and the edit is
/// acked, as desktop does.
#[tokio::test]
async fn a_bare_delete_wins_answer_keeps_the_row() {
    let db = scratch_db("bare");
    edited_task(&db, "t1", 5);
    let transport = FakeTransport::new(vec![
        response(200, &delete_wins("t1")),
        response(200, &pull_answer(Vec::new())),
    ]);
    let report = coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/pull").len(), 1);
    assert!(!task_deleted(&db, "t1"), "no evidence: the row stays");
    assert_eq!(report.deleted_locally, 0);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
}

/// An attested marker is the server's delete, verified: it applies through
/// the pulled-tombstone path and records its clock for a later re-create.
#[tokio::test]
async fn a_delete_wins_with_an_attested_marker_deletes_the_row() {
    let db = scratch_db("attested");
    edited_task(&db, "t1", 5);
    let transport = FakeTransport::new(vec![
        response(200, &delete_wins("t1")),
        response(200, &pull_answer(vec![marker("t1", 9, false)])),
    ]);
    let report = coordinator(&db, transport)
        .drain_wave()
        .await
        .expect("the wave");
    assert!(task_deleted(&db, "t1"));
    assert_eq!(report.deleted_locally, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_tombstone_clocks"),
        1,
        "the tombstone clock is recorded"
    );
}

#[tokio::test]
async fn a_delete_wins_with_a_forged_marker_keeps_the_row() {
    let db = scratch_db("forged");
    edited_task(&db, "t1", 5);
    let transport = FakeTransport::new(vec![
        response(200, &delete_wins("t1")),
        response(200, &pull_answer(vec![marker("t1", 9, true)])),
    ]);
    coordinator(&db, transport)
        .drain_wave()
        .await
        .expect("the wave");
    assert!(!task_deleted(&db, "t1"));
}

/// A name-keyed re-create whose clock happens after the delete's is the
/// user's: the §5.8 client rule keeps it, every push.
#[tokio::test]
async fn a_re_create_after_the_delete_is_not_deleted_again() {
    let db = scratch_db("recreate");
    edited(&db, "task", "t1", 5, r#"{"device-a":2,"device-b":3}"#);
    let transport = FakeTransport::new(vec![
        response(200, &delete_wins("t1")),
        response(200, &pull_answer(vec![marker("t1", 9, false)])),
    ]);
    let report = coordinator(&db, transport)
        .drain_wave()
        .await
        .expect("the wave");
    assert!(!task_deleted(&db, "t1"), "the re-create stays live");
    assert_eq!(report.deleted_locally, 0);
}

/// The answer names an id, not a type: a delete-wins for `inbox` cannot say
/// whether the tag or the settings row lost, so neither is deleted.
#[tokio::test]
async fn a_delete_wins_for_an_id_two_sent_items_share_deletes_neither() {
    let db = scratch_db("shared");
    edited(&db, "tag_definition", "inbox", 5, r#"{"device-b":3}"#);
    edited(&db, "settings", "inbox", 5, r#"{"device-b":3}"#);
    let transport = FakeTransport::new(vec![response(200, &delete_wins("inbox"))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert!(transport.calls_to("/sync/pull").is_empty());
    assert!(!deleted(&db, "tag_definition", "inbox"));
    assert!(!deleted(&db, "settings", "inbox"));
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
}

/// A by-id pull that fails leaves the item queued for a retry, deletes
/// nothing, and does not fail the wave.
#[tokio::test]
async fn a_failed_by_id_pull_defers_the_item_and_not_the_wave() {
    let db = scratch_db("pull-fails");
    edited_task(&db, "t1", 5);
    let transport = FakeTransport::new(vec![
        response(200, &delete_wins("t1")),
        response(404, r#"{"error":"NOT_FOUND"}"#),
    ]);
    let report = coordinator(&db, transport)
        .drain_wave()
        .await
        .expect("the wave survives");
    assert!(!task_deleted(&db, "t1"));
    assert_eq!(report.rejected, 1);
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM outbox WHERE last_error IS NOT NULL"
        ),
        1
    );
}

/// A remembered marker that will not parse: logged and deferred, the row
/// neither deleted nor sent, the wave intact.
#[tokio::test]
async fn an_unreadable_remembered_marker_defers_the_item_and_sends_nothing() {
    let db = scratch_db("unreadable");
    edited_task(&db, "t1", 5);
    kept_marker_value(&db, "t1", "not json".to_owned());
    let transport = FakeTransport::new(Vec::new());
    let report = coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave survives");
    assert!(transport.calls_to("/sync/push").is_empty());
    assert!(!task_deleted(&db, "t1"));
    assert_eq!(report.rejected, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 1);
}

/// #5406: a clockless marker the server accepts any update over. An edit of
/// the row the reconcile kept against it would reverse the delete on every
/// device, so it applies the marker's delete here and sends nothing.
#[tokio::test]
async fn an_edit_over_a_kept_clockless_marker_deletes_locally_and_sends_nothing() {
    let db = scratch_db("clockless");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, None);
    let transport = FakeTransport::new(Vec::new());
    let report = coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert!(transport.calls_to("/sync/push").is_empty());
    assert!(task_deleted(&db, "t1"));
    assert_eq!(report.deleted_locally, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(remembered(&db), 0);
}

/// A clocked marker the local edit happens strictly after is the §5.8 client
/// rule's keep: the server accepts that write, so it is sent.
#[tokio::test]
async fn an_edit_strictly_after_a_kept_clocked_marker_is_sent() {
    let db = scratch_db("after");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, Some(json!({"device-b": 2})));
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
    assert!(!task_deleted(&db, "t1"));
}

/// The server wrote the item after the marker (someone re-created it): the
/// marker no longer stands for the row, and the edit pushes as usual.
#[tokio::test]
async fn a_row_written_after_the_marker_pushes_normally() {
    let db = scratch_db("newer");
    edited_task(&db, "t1", 12);
    kept_marker(&db, "t1", 9, None);
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
    assert!(!task_deleted(&db, "t1"));
    assert_eq!(remembered(&db), 0);
}

/// A user who deletes the kept row has honoured the delete; a re-create of
/// the same id afterwards is theirs and is sent.
#[tokio::test]
async fn a_local_delete_forgets_the_marker() {
    let db = scratch_db("forget");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, None);
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::delete("task", "t1"), 2, |_| Ok(()))?;
        outbox::commit(conn, &Change::upsert("task", "t1"), 3, |_| Ok(())).map(|_| ())
    })
    .expect("delete and re-create");
    assert_eq!(remembered(&db), 0);
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
}
