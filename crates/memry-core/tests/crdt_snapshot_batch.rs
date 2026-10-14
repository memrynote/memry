//! `POST /sync/crdt/snapshot/batch` (chapter 07 §7.3, §7.4, #1857).
//!
//! Many documents ride one request, a server without the route latches the
//! pusher onto the single-note route, and a document with unmerged remote
//! state never reaches the wire.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, error_response, response};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::snapshots::{
    Refusal, SnapshotError, SnapshotGate, SnapshotOutcome, SnapshotPusher, SnapshotSealer,
};
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{Document, DocumentRegistry};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_debt;
use serde_json::json;
use yrs::{ReadTxn as _, StateVector, Transact as _, XmlFragment as _, XmlTextPrelim};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const A: &str = "aaaaaaaaaaa1";
const B: &str = "bbbbbbbbbbb2";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-snapshot-batch-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct PlainSealer;

impl SnapshotSealer for PlainSealer {
    fn seal_snapshot(&self, _doc_id: &str, state: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(state.to_vec())
    }
}

fn pusher(db: &Db, transport: Arc<FakeTransport>) -> SnapshotPusher {
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    SnapshotPusher::new(
        http,
        db.clone(),
        Arc::new(PlainSealer),
        Declaration::subscribed(),
    )
}

fn documents(registry: &DocumentRegistry, ids: &[&str]) -> Vec<Arc<Document>> {
    ids.iter()
        .map(|id| {
            let document = registry.get_or_open(id).expect("open");
            let author = yrs::Doc::with_client_id(99);
            let body = author.get_or_insert_xml_fragment("prosemirror");
            body.insert(&mut author.transact_mut(), 0, XmlTextPrelim::new(*id));
            let state = author
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            document.apply_durable_update(&state).expect("apply");
            document
        })
        .collect()
}

fn registry() -> DocumentRegistry {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new("device-a", sink)
}

fn clean(docs: &[Arc<Document>]) -> Vec<(&Document, SnapshotGate)> {
    docs.iter()
        .map(|d| (d.as_ref(), SnapshotGate::clean()))
        .collect()
}

fn stored_seq(db: &Db, id: &'static str) -> Option<i64> {
    db.call_blocking(move |conn| {
        Ok(update_log::snapshot(conn, Namespace::Server, id)
            .expect("read")
            .map(|row| row.last_seq))
    })
    .expect("read")
}

fn accepted(id: &str, seq: i64) -> serde_json::Value {
    json!({"noteId": id, "accepted": true, "sequenceNum": seq, "revision": format!("rev-{id}")})
}

#[tokio::test]
async fn many_documents_ride_one_request_and_each_stores_its_own_watermark() {
    let db = scratch_db("one-request");
    let registry = registry();
    let docs = documents(&registry, &[A, B]);
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"results": [accepted(A, 4), accepted(B, 9)]}).to_string(),
    )]);

    let outcomes = pusher(&db, transport.clone())
        .push_batch(&clean(&docs), 1)
        .await;

    assert_eq!(transport.call_count(), 1);
    let sent = http_fakes::body_json(&transport.calls_to("/sync/crdt/snapshot/batch")[0]);
    let ids: Vec<&str> = sent["snapshots"]
        .as_array()
        .expect("snapshots")
        .iter()
        .map(|entry| entry["noteId"].as_str().expect("noteId"))
        .collect();
    assert_eq!(ids, [A, B]);
    assert_eq!(outcomes.len(), 2);
    assert!(
        outcomes
            .iter()
            .all(|(_, o)| matches!(o, Ok(SnapshotOutcome::Pushed { .. })))
    );
    assert_eq!(stored_seq(&db, A), Some(4));
    assert_eq!(stored_seq(&db, B), Some(9));
}

#[tokio::test]
async fn a_server_without_the_route_latches_the_single_note_route_for_the_session() {
    let db = scratch_db("latch");
    let registry = registry();
    let docs = documents(&registry, &[A, B]);
    let one = || response(200, &json!({"sequenceNum": 2}).to_string());
    let transport = FakeTransport::new(vec![
        error_response(404, "NOT_FOUND", "no route"),
        one(),
        one(),
        one(),
        one(),
    ]);
    let pusher = pusher(&db, transport.clone());

    let first = pusher.push_batch(&clean(&docs), 1).await;
    let second = pusher.push_batch(&clean(&docs), 2).await;

    for (_, outcome) in first.iter().chain(&second) {
        assert!(
            matches!(outcome, Ok(SnapshotOutcome::Pushed { .. })),
            "{outcome:?}"
        );
    }
    // One 404, then never the batch route again.
    assert_eq!(transport.calls_to("/sync/crdt/snapshot/batch").len(), 1);
    assert_eq!(transport.call_count(), 5);
}

#[tokio::test]
async fn a_document_with_unmerged_remote_state_never_rides_the_batch() {
    let db = scratch_db("unmerged");
    let registry = registry();
    let docs = documents(&registry, &[A, B]);
    db.call_blocking(|conn| body_debt::owe(conn, A))
        .expect("owe");
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"results": [accepted(B, 3)]}).to_string(),
    )]);

    let outcomes = pusher(&db, transport.clone())
        .push_batch(&clean(&docs), 1)
        .await;

    assert_eq!(outcomes[0].0, A);
    assert!(matches!(
        outcomes[0].1,
        Ok(SnapshotOutcome::Refused(Refusal::UnmergedRemoteState))
    ));
    let sent = http_fakes::body_json(&transport.calls_to("/sync/crdt/snapshot/batch")[0]);
    assert_eq!(sent["snapshots"].as_array().expect("snapshots").len(), 1);
    assert_eq!(sent["snapshots"][0]["noteId"], json!(B));
}

#[tokio::test]
async fn per_note_rejections_stay_per_note() {
    let db = scratch_db("rejections");
    let registry = registry();
    let docs = documents(&registry, &[A, B, "ccccccccccc3"]);
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"results": [
            {"noteId": A, "accepted": false, "reason": "CRDT_SNAPSHOT_NOT_COVERED"},
            {"noteId": B, "accepted": false, "reason": "payload too large"},
        ]})
        .to_string(),
    )]);

    let outcomes = pusher(&db, transport).push_batch(&clean(&docs), 1).await;

    // Not covered: the document is owed a pull, so the next push refuses locally.
    assert!(matches!(
        outcomes[0].1,
        Ok(SnapshotOutcome::Refused(Refusal::UnmergedRemoteState))
    ));
    assert!(
        db.call_blocking(|conn| body_debt::is_owed(conn, A))
            .expect("read")
    );
    assert!(matches!(outcomes[1].1, Err(SnapshotError::Rejected { .. })));
    // Unanswered: not stored, reported as a failure to retry.
    assert!(outcomes[2].1.is_err());
    assert_eq!(stored_seq(&db, "ccccccccccc3"), None);
}
