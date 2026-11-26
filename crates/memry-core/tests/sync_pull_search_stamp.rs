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

use crate::support::{ScratchDb, scratch_data_db};
use crate::{http_fakes, stamp_gate};

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, probe_refused, response};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::seams::transport::Transport;
use memry_core::storage::Db;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};
use stamp_gate::{GatedTransport, RIVAL_NOTE, Search, land_note, note_payload};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const NOTE: &str = "page0note000";
const WORD: &str = "quokkabody";

fn scratch_db(label: &str) -> ScratchDb {
    scratch_data_db(&format!("pull-search-stamp-{label}"))
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
fn indexed_note(label: &str) -> (ScratchDb, Search) {
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
