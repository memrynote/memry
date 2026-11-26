//! Sync writers' search stamps against a reindex that ran while the writer
//! waited for `data.db` (#5849).
//!
//! Each test parks one writer on `data.db` behind [`stamp_gate`]'s gate,
//! which moves the watermark past any stamp taken before the hold. The next
//! incremental reindex must still see what the writer wrote.
//!
//! Real `HttpClient`, SQLite, pull, body pull and reindex; the
//! transport and the ciphers are the only fakes.
//!
//! | Test                                           | Stamp                       |
//! | ---------------------------------------------- | --------------------------- |
//! | a record page                                  | `notes.synced_at`           |
//! | a by-id pull (the shared apply)                | `notes.synced_at`           |
//! | a body pull's server update                    | `yjs_updates.created_at`    |
//! | a body pull's baseline                         | `yjs_snapshots.compacted_at`|
//! | a pushed snapshot absorbing a server update    | `yjs_snapshots.compacted_at`|

mod http_fakes;
mod stamp_gate;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, probe_refused, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::epoch;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::snapshots::{SnapshotGate, SnapshotOutcome, SnapshotPusher, SnapshotSealer};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::Transport;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};
use stamp_gate::{GatedTransport, RIVAL_NOTE, Search, land_note, note_payload};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "page0note000";
const WORD: &str = "quokkabody";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-pull-search-stamp-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn http(transport: Arc<dyn Transport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

/// Opens [`NOTE`]'s record.
struct Records;

impl RecordCipher for Records {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        assert_eq!(envelope.id, NOTE);
        Ok(note_payload("Paged").into_bytes())
    }
}

/// Hands the packed bytes back as the plaintext.
struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.packed.to_vec())
    }
}

fn pull(db: &Db, transport: Arc<dyn Transport>) -> PullLoop {
    PullLoop::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Records),
    )
}

fn note_envelope() -> Json {
    json!({
        "id": NOTE,
        "type": "note",
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
    })
}

/// A `blockContainer > paragraph > text` body holding [`WORD`].
fn body_update() -> String {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new(format!("The {WORD} text.")));
    }
    BASE64.encode(
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
    )
}

/// [`NOTE`] pulled and indexed, before the writer under test runs.
fn indexed_note(label: &str) -> (Db, Search) {
    let db = scratch_db(label);
    db.call_blocking(|conn| land_note(conn, NOTE, "Held", 1))
        .expect("land the note");
    let search = Search::new(&db);
    assert!(search.indexed(NOTE));
    (db, search)
}

/// The gate ran: its reindex saw the rival note.
fn gate_ran(transport: &GatedTransport, search: &Search) {
    transport.join();
    assert!(search.indexed(RIVAL_NOTE));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_page_that_waited_through_a_reindex_is_indexed_next_pass() {
    let db = scratch_db("page");
    let search = Search::new(&db);
    let transport = GatedTransport::new(
        FakeTransport::new(vec![
            response(
                200,
                &json!({"items": [{"id": NOTE, "type": "note"}], "deleted": [],
                        "hasMore": false, "nextCursor": "1"})
                .to_string(),
            ),
            response(200, &json!({ "items": [note_envelope()] }).to_string()),
        ]),
        "/sync/pull",
        &search,
    );

    let report = pull(&db, transport.clone())
        .pull_page()
        .await
        .expect("the page");
    assert_eq!(report.applied, 1);
    gate_ran(&transport, &search);

    search.reindex();
    assert!(
        search.indexed(NOTE),
        "the next reindex skipped the page's note"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_by_id_pull_that_waited_through_a_reindex_is_indexed_next_pass() {
    let db = scratch_db("by-id");
    let search = Search::new(&db);
    let transport = GatedTransport::new(
        FakeTransport::new(vec![response(
            200,
            &json!({ "items": [note_envelope()] }).to_string(),
        )]),
        "/sync/pull",
        &search,
    );

    let report = pull(&db, transport.clone())
        .fetch_ids(&[NOTE.to_owned()])
        .await
        .expect("the by-id pull");
    assert_eq!(report.applied, 1);
    gate_ran(&transport, &search);

    search.reindex();
    assert!(
        search.indexed(NOTE),
        "the next reindex skipped the pulled note"
    );
}

fn body_pull(db: &Db, transport: Arc<dyn Transport>) -> BodyPull {
    BodyPull::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_update_that_waited_through_a_reindex_is_indexed_next_pass() {
    let (db, search) = indexed_note("update");
    let transport = GatedTransport::new(
        FakeTransport::new(vec![
            probe_refused(),
            response(200, &json!({"snapshot": null}).to_string()),
            response(
                200,
                &json!({"updates": [{"sequenceNum": 1, "signerDeviceId": "device-b",
                                     "data": body_update()}],
                        "hasMore": false})
                .to_string(),
            ),
        ]),
        "/sync/crdt/updates?note_id=",
        &search,
    );

    let report = body_pull(&db, transport.clone())
        .pull_document(NOTE)
        .await
        .expect("the body pull");
    assert_eq!(report.updates, 1);
    gate_ran(&transport, &search);

    search.reindex();
    assert!(
        search.finds(WORD, NOTE),
        "the next reindex skipped the note's pulled body"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_baseline_that_waited_through_a_reindex_is_indexed_next_pass() {
    let (db, search) = indexed_note("baseline");
    let transport = GatedTransport::new(
        FakeTransport::new(vec![
            probe_refused(),
            response(
                200,
                &json!({"snapshot": body_update(), "sequenceNum": 1,
                        "signerDeviceId": "device-b", "revision": "r1"})
                .to_string(),
            ),
            response(200, &json!({"updates": [], "hasMore": false}).to_string()),
        ]),
        "/sync/crdt/snapshot",
        &search,
    );

    body_pull(&db, transport.clone())
        .pull_document(NOTE)
        .await
        .expect("the body pull");
    gate_ran(&transport, &search);

    search.reindex();
    assert!(
        search.finds(WORD, NOTE),
        "the next reindex skipped the note's baseline"
    );
}

/// A snapshot pusher whose sealer hands the state back as it is.
fn snapshot_pusher(db: &Db, transport: Arc<dyn Transport>) -> SnapshotPusher {
    SnapshotPusher::new(
        http(transport),
        db.clone(),
        Arc::new(PlainSealer),
        Declaration::subscribed(),
    )
}

struct PlainSealer;

impl SnapshotSealer for PlainSealer {
    fn seal_snapshot(&self, _doc_id: &str, state: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(state.to_vec())
    }
}

/// A snapshot push absorbs (prunes) a server update that landed after the last
/// reindex and was never indexed. The snapshot it stores is the only row left
/// that holds the update's text, so its stamp must be at or after that
/// update's: a stamp taken before the round (the driver's, #5849 review) is
/// below the reindex watermark, and the next pass would skip the body.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pushed_snapshot_that_absorbs_an_unindexed_update_is_indexed_next_pass() {
    let (db, search) = indexed_note("snapshot");
    let round_began = stamp_gate::wall_ms();
    while stamp_gate::wall_ms() <= round_began {
        std::thread::yield_now();
    }
    db.call_blocking(|conn| land_note(conn, RIVAL_NOTE, "Rival", stamp_gate::wall_ms()))
        .expect("land the rival");
    search.reindex();
    assert!(search.watermark() > round_began);

    let pulled = body_pull(
        &db,
        FakeTransport::new(vec![
            probe_refused(),
            response(200, &json!({"snapshot": null}).to_string()),
            response(
                200,
                &json!({"updates": [{"sequenceNum": 1, "signerDeviceId": "device-b",
                                     "data": body_update()}],
                        "hasMore": false})
                .to_string(),
            ),
        ]),
    )
    .pull_document(NOTE)
    .await
    .expect("the body pull");
    assert_eq!(pulled.updates, 1);

    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-a", sink);
    let document = registry.get_or_open(NOTE).expect("open");
    let update = BASE64.decode(body_update()).expect("base64");
    document.apply_durable_update(&update).expect("apply");
    let opened_at = db
        .call_blocking(|conn| {
            epoch::capture(conn, NOTE).map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the epoch");
    let outcome = snapshot_pusher(
        &db,
        FakeTransport::new(vec![response(
            200,
            &json!({"sequenceNum": 1, "revision": "rev-pushed"}).to_string(),
        )]),
    )
    .push(&document, opened_at, SnapshotGate::clean())
    .await
    .expect("the push");
    assert_eq!(
        outcome,
        SnapshotOutcome::Pushed {
            sequence_num: 1,
            pruned: 1
        }
    );

    search.reindex();
    assert!(
        search.finds(WORD, NOTE),
        "the next reindex skipped the body the snapshot absorbed"
    );
}
