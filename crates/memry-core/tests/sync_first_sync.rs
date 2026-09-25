//! The first-sync sub-sequence and the downward CRDT feed, against real
//! adapters.
//!
//! Real `HttpClient`, real SQLite, real `yrs`, real chapter 04 §4.11 crypto.
//! The only fakes are the `Transport` — a foreign trait by construction
//! (Constitution I) — and the record cipher, whose key directory is a later
//! task's. **Nothing here reaches a network.**
//!
//! | Test                                     | Rule                                |
//! | ---------------------------------------- | ----------------------------------- |
//! | bodies reach `yjs_updates`               | chapter 07 §7.8, §7.9; FR-028       |
//! | a kill mid-run resumes                   | data-model §C.3, chapter 05 §5.11   |
//! | an unopenable update stops the document  | §7.9's stop-at-gap                  |
//! | a baseline is taken only when §7.8 says  | §7.8, §7.5                          |
//! | a tombstoned document is not body-pulled | §7.15                               |

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack, unpack};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::instants;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate, crdt_cursor_scope};
use memry_core::sync::first_sync::{FirstSync, FirstSyncProgress, ProgressSink};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, GetString as _, ReadTxn as _, StateVector, Transact as _, Update, XmlElementPrelim,
    XmlFragment as _, XmlTextPrelim,
};

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";
const VAULT_KEY: [u8; 32] = [3u8; 32];
const MODIFIED_AT: &str = "2026-09-10T00:00:00.000Z";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-first-sync-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// A record cipher that hands back a scripted plaintext per id.
struct ScriptedCipher(Vec<(String, String)>);

impl ScriptedCipher {
    fn new(plaintexts: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self(
            plaintexts
                .iter()
                .map(|(id, payload)| ((*id).to_owned(), (*payload).to_owned()))
                .collect(),
        ))
    }
}

impl RecordCipher for ScriptedCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

/// The real chapter 04 §4.12 open, over a key directory of one device.
///
/// A device id this directory does not know is an **unresolvable signer**,
/// which is §7.9's stop-at-gap condition, and that is the only way this cipher
/// is made to fail.
struct RealCrdtCipher {
    keys: Vec<(String, Vec<u8>)>,
    opened: Mutex<Vec<String>>,
}

impl RealCrdtCipher {
    fn with(device_id: &str, public_key: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            keys: vec![(device_id.to_owned(), public_key)],
            opened: Mutex::new(Vec::new()),
        })
    }
}

impl CrdtCipher for RealCrdtCipher {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        self.opened
            .lock()
            .unwrap()
            .push(update.signer_device_id.unwrap_or("<none>").to_owned());
        let signer = update
            .signer_device_id
            .ok_or(EnvelopeError::SignatureInvalid)?;
        let public_key = self
            .keys
            .iter()
            .find(|(id, _)| id == signer)
            .map(|(_, key)| key.clone())
            .ok_or(EnvelopeError::SignatureInvalid)?;
        unpack(update.packed, update.doc_id, &VAULT_KEY, &public_key)
    }
}

/// A `blockContainer > paragraph > text` body, which is the smallest thing
/// `extract_text` reports a line for.
fn body_update(text: &str) -> Vec<u8> {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// Chapter 04 §4.11's packed envelope, base64, exactly as the wire carries it.
fn packed_base64(doc_id: &str, update: &[u8], secret_key: &[u8]) -> String {
    let packed = pack(
        &CrdtRequest {
            note_id: doc_id,
            update,
            vault_key: &VAULT_KEY,
            signing_secret_key: secret_key,
        },
        &CrdtMaterial::random(),
    )
    .expect("pack");
    BASE64.encode(packed)
}

fn note_payload() -> String {
    json!({"title": "A note", "modifiedAt": MODIFIED_AT}).to_string()
}

fn record_envelope(id: &str, item_type: &str) -> Json {
    json!({
        "id": id,
        "type": item_type,
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-a",
    })
}

fn changes_page(
    ids: &[(&str, &str)],
    deleted: &[&str],
    next_cursor: i64,
    has_more: bool,
) -> String {
    let items: Vec<Json> = ids
        .iter()
        .map(|(id, item_type)| {
            json!({"id": id, "type": item_type, "version": 1, "modifiedAt": epoch(MODIFIED_AT), "size": 12})
        })
        .collect();
    json!({"items": items, "deleted": deleted, "hasMore": has_more, "nextCursor": next_cursor})
        .to_string()
}

fn epoch(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("a parseable instant")
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

/// Every progress report, in order.
#[derive(Default)]
struct RecordedProgress(Mutex<Vec<FirstSyncProgress>>);

impl RecordedProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn seen(&self) -> Vec<FirstSyncProgress> {
        self.0.lock().unwrap().clone()
    }
}

impl ProgressSink for RecordedProgress {
    fn progress(&self, progress: FirstSyncProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

/// Replays both namespaces into a fresh document, which is the only door
/// chapter 12 §12.5.1 allows, and extracts its text.
fn text_of(db: &Db, doc_id: &str) -> String {
    let id = doc_id.to_owned();
    let blobs = db
        .call_blocking(move |conn| {
            update_log::load_plan(conn, &id)
                .map(|plan| plan.blobs().into_iter().map(<[u8]>::to_vec).collect())
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("load plan");
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-reader", sink)
        .get_or_open(doc_id)
        .expect("open");
    let blobs: Vec<Vec<u8>> = blobs;
    for blob in &blobs {
        document.apply_durable_update(blob).expect("apply");
    }
    extract_text(&document).expect("extract")
}

// ----------------------------------------------------------------- the tests

#[tokio::test]
async fn a_first_sync_fills_yjs_updates_so_extract_text_returns_the_body() {
    let db = scratch_db("bodies");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
    let update = body_update("Hello from the server");

    let transport = FakeTransport::new(vec![
        // Pass one: refs to the end.
        response(200, &changes_page(&[(NOTE, "note")], &[], 10, false)),
        // Pass two: metadata, newest first.
        response(
            200,
            &json!({"items": [record_envelope(NOTE, "note")]}).to_string(),
        ),
        // Pass three: the cursor is 0, so §7.8's first clause takes the
        // snapshot first. This document has none.
        response(200, &json!({"snapshot": Json::Null}).to_string()),
        response(
            200,
            &json!({"updates": [{
                "sequenceNum": 1,
                "data": packed_base64(NOTE, &update, &secret_key),
                "createdAt": 1_700_000_000_000i64,
                "signerDeviceId": "device-a"
            }], "hasMore": false})
            .to_string(),
        ),
    ]);

    let progress = RecordedProgress::new();
    let report = first_sync(&db, transport, public_key, progress.clone())
        .run(epoch(MODIFIED_AT) + 1_000)
        .await
        .expect("the first sync");

    assert_eq!(report.refs_recorded, 1);
    assert_eq!(report.metadata_applied, 1);
    assert_eq!(report.bodies.documents, 1);
    assert_eq!(report.bodies.updates, 1, "the body reached yjs_updates");
    assert!(report.bodies.stopped.is_empty());

    // The point of the whole task: `notes text` can now answer.
    assert_eq!(text_of(&db, NOTE), "Hello from the server");

    // §7.9: the watermark is the sequence the server assigned.
    let cursor = db
        .call_blocking(|conn| store::read_cursor(conn, &crdt_cursor_scope(NOTE)))
        .expect("cursor");
    assert_eq!(cursor.as_deref(), Some("1"));

    // FR-028: determinate, and never above one.
    let seen = progress.seen();
    assert!(seen.iter().all(|p| p.completed <= p.total));
    assert!(
        seen.iter()
            .any(|p| p.phase == memry_core::sync::first_sync::FirstSyncPhase::Bodies)
    );
}

#[tokio::test]
async fn a_kill_mid_first_sync_resumes_without_re_pulling_or_skipping() {
    let db = scratch_db("resume");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[9u8; 32]).expect("keypair");
    let other = "def456abc789";

    // The first run dies inside the metadata pass: the refs page landed, the
    // `/sync/pull` chunk never answered.
    let dying = FakeTransport::new(vec![
        response(
            200,
            &changes_page(&[(NOTE, "note"), (other, "note")], &[], 10, false),
        ),
        Err(memry_core::api::errors::TransportError::Cancelled),
    ]);
    let killed = first_sync(
        &db,
        dying.clone(),
        public_key.clone(),
        RecordedProgress::new(),
    )
    .run(epoch(MODIFIED_AT) + 1_000)
    .await;
    assert!(killed.is_err(), "the run died mid-metadata");

    // Both refs are durable and the record cursor advanced with them, so the
    // resumed run does not re-walk the feed for work it already recorded.
    let cursor = db
        .call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("cursor");
    assert_eq!(cursor.as_deref(), Some("10"));

    let update = body_update("Recovered");
    let resumed_transport = FakeTransport::new(vec![
        // Refs resume from the committed cursor: one page, nothing new.
        response(200, &changes_page(&[], &[], 10, false)),
        // Metadata: the two rows still carrying `metadata-only`, and no others.
        response(
            200,
            &json!({"items": [record_envelope(NOTE, "note"), record_envelope(other, "note")]})
                .to_string(),
        ),
        // Bodies, both documents: baseline probe then incrementals.
        response(200, &json!({"snapshot": Json::Null}).to_string()),
        response(
            200,
            &json!({"updates": [{
                "sequenceNum": 1,
                "data": packed_base64(NOTE, &update, &secret_key),
                "signerDeviceId": "device-a"
            }], "hasMore": false})
            .to_string(),
        ),
        response(200, &json!({"snapshot": Json::Null}).to_string()),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]);
    let report = first_sync(
        &db,
        resumed_transport.clone(),
        public_key,
        RecordedProgress::new(),
    )
    .run(epoch(MODIFIED_AT) + 2_000)
    .await
    .expect("the resumed run");

    assert_eq!(report.metadata_applied, 2, "neither row was skipped");
    assert_eq!(report.bodies.updates, 1);
    assert_eq!(text_of(&db, NOTE), "Recovered");

    // Exactly one `/sync/pull` call: the resumed metadata pass asked for the
    // two outstanding ids and for nothing it had already applied.
    assert_eq!(resumed_transport.calls_to("/sync/pull").len(), 1);
    let asked = http_fakes::body_json(&resumed_transport.calls_to("/sync/pull")[0]);
    // `itemIds` is the field the server actually reads; staging answered
    // `400 expected array, received undefined` to `ids` (spec defect 50).
    let mut ids: Vec<String> = asked["itemIds"]
        .as_array()
        .expect("itemIds")
        .iter()
        .map(|id| id.as_str().expect("a string id").to_owned())
        .collect();
    ids.sort();
    assert_eq!(ids, vec![NOTE.to_owned(), other.to_owned()]);
}

#[tokio::test]
async fn an_update_this_client_cannot_open_stops_the_document_at_that_update() {
    let db = scratch_db("stop-at-gap");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[11u8; 32]).expect("keypair");

    let transport = FakeTransport::new(vec![
        // The baseline probe: no snapshot.
        response(200, &json!({"snapshot": Json::Null}).to_string()),
        response(
            200,
            &json!({"updates": [
                {"sequenceNum": 1, "data": packed_base64(NOTE, &body_update("first"), &secret_key), "signerDeviceId": "device-a"},
                // §7.9: an unresolvable signer. Everything after it must stay
                // unpulled, or the cursor would step over update 2 forever.
                {"sequenceNum": 2, "data": packed_base64(NOTE, &body_update("second"), &secret_key), "signerDeviceId": "device-unknown"},
                {"sequenceNum": 3, "data": packed_base64(NOTE, &body_update("third"), &secret_key), "signerDeviceId": "device-a"}
            ], "hasMore": true})
            .to_string(),
        ),
    ]);
    let cipher = RealCrdtCipher::with("device-a", public_key);
    let bodies = BodyPull::new(
        http(transport.clone()),
        db.clone(),
        Declaration::subscribed(),
        cipher,
    );

    let report = bodies.pull_document(NOTE).await.expect("the pull");
    assert_eq!(report.updates, 1, "only the update before the gap");
    assert_eq!(report.stopped, vec![NOTE.to_owned()]);
    // An update landed in the durable log, so a resident `Document` for this
    // id is now behind it. The storage tier holds no registry and cannot fix
    // that; naming the id is how a caller that owns one finds out. A document
    // that stopped at its first update would not appear here.
    assert_eq!(
        report.advanced_documents,
        vec![NOTE.to_owned()],
        "a document whose log gained an update must be named for the registry holder"
    );

    let cursor = db
        .call_blocking(|conn| store::read_cursor(conn, &crdt_cursor_scope(NOTE)))
        .expect("cursor");
    assert_eq!(
        cursor.as_deref(),
        Some("1"),
        "the watermark did not advance past the gap, so a later pass retries it"
    );
    // `hasMore` was true and the page had more entries: the stop wins over
    // both.
    assert_eq!(transport.call_count(), 2);
}

#[tokio::test]
async fn a_pulled_update_is_stamped_with_this_devices_clock_not_the_servers() {
    // The search index reindexes a body whose `yjs_updates.created_at` is at
    // or above its epoch-ms watermark. A server `createdAt` (here seconds,
    // as the staging server sends) sat below it forever, so a body edited on
    // another device never re-indexed and its links never became backlinks.
    let db = scratch_db("apply-stamp");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[12u8; 32]).expect("keypair");
    let transport = FakeTransport::new(vec![
        response(200, &json!({"snapshot": Json::Null}).to_string()),
        response(
            200,
            &json!({"updates": [
                {"sequenceNum": 1, "data": packed_base64(NOTE, &body_update("first"), &secret_key), "createdAt": 1_700_000_000i64, "signerDeviceId": "device-a"}
            ], "hasMore": false})
            .to_string(),
        ),
    ]);
    let bodies = BodyPull::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        RealCrdtCipher::with("device-a", public_key),
    );
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;

    let report = bodies.pull_document(NOTE).await.expect("the pull");
    assert_eq!(report.updates, 1);
    let stamp: i64 = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT created_at FROM yjs_updates WHERE doc_id = ?1",
                [NOTE],
                |row| row.get(0),
            )
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect("the stored row");
    assert!(
        stamp >= before,
        "stamped at apply time in epoch ms, got {stamp}"
    );
}

#[tokio::test]
async fn a_baseline_is_taken_when_the_advertised_revision_differs_and_not_otherwise() {
    let db = scratch_db("baseline");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[13u8; 32]).expect("keypair");

    // This device is already at sequence 5 with a snapshot at revision
    // `rev-1`, which is what the server is about to advertise.
    db.call_blocking(|conn| {
        update_log::put_server_snapshot(conn, NOTE, b"unused", 4, Some("rev-1"), 1).map_err(
            |error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            },
        )?;
        store::write_cursor(conn, &crdt_cursor_scope(NOTE), Some("5"), 1)
    })
    .expect("seed");

    let transport = FakeTransport::new(vec![
        // §7.8: ahead of the cursor is false here (8 > 5 is true), but the
        // revision is the one already stored, so no baseline.
        response(
            200,
            &json!({
                "updates": [{"sequenceNum": 6, "data": packed_base64(NOTE, &body_update("six"), &secret_key), "signerDeviceId": "device-a"}],
                "hasMore": false,
                "snapshotMeta": {NOTE: {"sequenceNum": 8, "revision": "rev-1"}}
            })
            .to_string(),
        ),
    ]);
    let bodies = BodyPull::new(
        http(transport.clone()),
        db.clone(),
        Declaration::subscribed(),
        RealCrdtCipher::with("device-a", public_key),
    );
    let report = bodies.pull_document(NOTE).await.expect("the pull");
    assert_eq!(report.baselines, 0, "§7.5: equality, and nothing else");
    assert_eq!(report.updates, 1);
    assert_eq!(
        transport
            .calls_to(&format!("/sync/crdt/snapshot/{NOTE}"))
            .len(),
        0
    );
}

#[tokio::test]
async fn a_document_with_no_snapshot_meta_takes_no_baseline_above_cursor_zero() {
    let db = scratch_db("no-meta");
    let (public_key, _secret) =
        memry_core::crypto::sodium::sign_seed_keypair(&[17u8; 32]).expect("keypair");
    db.call_blocking(|conn| store::write_cursor(conn, &crdt_cursor_scope(NOTE), Some("3"), 1))
        .expect("seed");

    // §7.8's `: false` branch: an old server advertises nothing, and the
    // reference does not fetch.
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"updates": [], "hasMore": false}).to_string(),
    )]);
    let bodies = BodyPull::new(
        http(transport.clone()),
        db.clone(),
        Declaration::subscribed(),
        RealCrdtCipher::with("device-a", public_key),
    );
    let report = bodies.pull_document(NOTE).await.expect("the pull");
    assert_eq!(report.baselines, 0);
    assert_eq!(transport.call_count(), 1);
}

#[tokio::test]
async fn a_tombstoned_document_is_never_body_pulled() {
    let db = scratch_db("tombstone");
    let (public_key, _secret) =
        memry_core::crypto::sodium::sign_seed_keypair(&[19u8; 32]).expect("keypair");

    let transport = FakeTransport::new(vec![
        // The refs page carries the note **and** its tombstone.
        response(200, &changes_page(&[(NOTE, "note")], &[NOTE], 10, false)),
        // Nothing is outstanding for the metadata pass: the row is deleted.
        // The bodies pass finds no live note. So the script ends here, and
        // running past it would panic.
    ]);
    let report = first_sync(&db, transport.clone(), public_key, RecordedProgress::new())
        .run(epoch(MODIFIED_AT) + 1_000)
        .await
        .expect("the first sync");

    assert_eq!(report.tombstones, 1);
    assert_eq!(report.bodies.documents, 0, "§7.15: not one body request");
    assert_eq!(transport.call_count(), 1);
}

/// The whole first sync wired to one scripted transport.
fn first_sync(
    db: &Db,
    transport: Arc<FakeTransport>,
    signer_public_key: Vec<u8>,
    progress: Arc<RecordedProgress>,
) -> FirstSync {
    let http = http(transport);
    let pull = Arc::new(PullLoop::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        ScriptedCipher::new(&[(NOTE, &note_payload()), ("def456abc789", &note_payload())]),
    ));
    let bodies = Arc::new(BodyPull::new(
        http,
        db.clone(),
        Declaration::subscribed(),
        RealCrdtCipher::with("device-a", signer_public_key),
    ));
    FirstSync::new(pull, bodies, db.clone()).with_progress(progress)
}

#[test]
fn a_replayed_update_is_skipped_rather_than_re_applied() {
    // §7.9's replay rule, at the storage layer: the same sequence twice is a
    // duplicate delivery, not new data, and the second one changes nothing.
    let db = scratch_db("replay");
    let update = body_update("once");
    db.call_blocking(|conn| {
        update_log::append_server_update(conn, NOTE, 1, &update, 1).expect("first");
        update_log::append_server_update(conn, NOTE, 1, b"different", 2).expect("second");
        Ok(())
    })
    .expect("append");

    let rows = db
        .call_blocking(|conn| {
            update_log::updates_after(conn, Namespace::Server, NOTE, 0).map_err(|error| {
                memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].update_blob, update);

    // And the bytes really are a note body, not an opaque blob this test
    // never proved anything about.
    let reader = Doc::new();
    reader
        .transact_mut()
        .apply_update(Update::decode_v1(&update).expect("decode"))
        .expect("apply");
    let fragment = reader.get_or_insert_xml_fragment("prosemirror");
    assert!(fragment.get_string(&reader.transact()).contains("once"));
}
