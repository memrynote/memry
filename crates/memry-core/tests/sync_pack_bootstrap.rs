//! The fresh-device pack bootstrap against real adapters (chapter 08, #3252).
//!
//! Real `HttpClient`, SQLite, `yrs`, chapter 04 §4.11 crypto and the chapter
//! 08 reader. The only fake is the `Transport`. The pack bytes are built here
//! because the client is never a pack writer (§8.1).

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log;
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack, unpack};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate, crdt_cursor_scope};
use memry_core::sync::driver::observer::{ApplyObserver, Observers};
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::pack_bootstrap::{META_PACKS_APPLIED_THROUGH, PackBootstrap};
use memry_core::sync::store;
use serde_json::{Value as Json, json};
use sha2::{Digest as _, Sha256};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const NOTE: &str = "abc123def456";
const VAULT_KEY: [u8; 32] = [3u8; 32];
const PACK_URL: &str = "https://r2.example/packs/p1";

fn scratch_db(label: &str) -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-pack-bootstrap-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

/// The real §4.12 open over a directory of one device.
struct Directory {
    device_id: String,
    public_key: Vec<u8>,
}

impl CrdtCipher for Directory {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if update.signer_device_id != Some(self.device_id.as_str()) {
            return Err(EnvelopeError::SignatureInvalid);
        }
        unpack(update.packed, update.doc_id, &VAULT_KEY, &self.public_key)
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec![self.device_id.clone()]
    }
}

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

fn packed(doc_id: &str, update: &[u8], secret_key: &[u8]) -> Vec<u8> {
    pack(
        &CrdtRequest {
            note_id: doc_id,
            update,
            vault_key: &VAULT_KEY,
            signing_secret_key: secret_key,
        },
        &CrdtMaterial::random(),
    )
    .expect("pack")
}

/// A chapter 08 container: header, payload, index block, footer.
fn mpak(entries: &[(&str, Option<Json>, Vec<u8>)]) -> Vec<u8> {
    let text = |out: &mut Vec<u8>, value: &str| {
        out.extend((value.len() as u16).to_be_bytes());
        out.extend(value.as_bytes());
    };
    let mut payload = Vec::new();
    let mut index = Vec::new();
    for (id, meta, bytes) in entries {
        index.push(1u8); // crdt_snapshot
        text(&mut index, id);
        text(&mut index, &format!("crdt/{id}"));
        index.extend(1_760_000_000u64.to_be_bytes());
        text(
            &mut index,
            &meta.as_ref().map(Json::to_string).unwrap_or_default(),
        );
        index.extend((payload.len() as u64).to_be_bytes());
        index.extend((bytes.len() as u64).to_be_bytes());
        index.extend(Sha256::digest(bytes));
        payload.extend(bytes);
    }
    let mut out = b"MPAK".to_vec();
    out.extend([1u8, 0, 0, 0]);
    out.extend(&payload);
    let index_offset = out.len() as u64;
    out.extend(&index);
    out.extend(Sha256::digest(&payload));
    out.extend((entries.len() as u64).to_be_bytes());
    out.extend(index_offset.to_be_bytes());
    out.extend(b"MPAK");
    out.push(1);
    out
}

fn listing(max_cursor: i64) -> String {
    json!({
        "packs": [
            {"id": "p1", "itemKind": "crdt_snapshot", "packKey": "k", "minCursor": 1,
             "maxCursor": max_cursor, "itemCount": 3, "byteSize": 10, "createdAt": 1,
             "url": PACK_URL, "expiresAt": 4_000_000_000i64},
            // Record packs carry no signature and are never applied.
            {"id": "r1", "itemKind": "record", "packKey": "k", "minCursor": 1,
             "maxCursor": 99, "itemCount": 1, "byteSize": 10, "createdAt": 1,
             "url": "https://r2.example/packs/r1", "expiresAt": 4_000_000_000i64}
        ],
        "serverTime": 1
    })
    .to_string()
}

fn bytes_response(
    bytes: Vec<u8>,
) -> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    Ok(memry_core::seams::transport::HttpResponse {
        status: 200,
        headers: Default::default(),
        body: bytes,
    })
}

fn text_of(db: &Db, doc_id: &str) -> String {
    let id = doc_id.to_owned();
    let blobs: Vec<Vec<u8>> = db
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
    for blob in &blobs {
        document.apply_durable_update(blob).expect("apply");
    }
    extract_text(&document).expect("extract")
}

fn cursor_of(db: &Db, doc_id: &str) -> Option<String> {
    let scope = crdt_cursor_scope(doc_id);
    db.call_blocking(move |conn| store::read_cursor(conn, &scope))
        .expect("cursor")
}

#[tokio::test]
async fn a_packed_snapshot_seeds_the_body_and_the_bodies_pass_skips_its_snapshot_get() {
    let db = scratch_db("seed");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
    let (_, stranger_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[8u8; 32]).expect("keypair");
    let pack_bytes = mpak(&[
        (
            NOTE,
            Some(json!({"sequenceNum": 7, "revision": "rev-7"})),
            packed(NOTE, &body_update("Hello from a pack"), &secret_key),
        ),
        // No freshness token: not trusted, left to its GET.
        (
            "nometa000001",
            None,
            packed("nometa000001", &body_update("x"), &secret_key),
        ),
        // Signed by no registered device: refused.
        (
            "stranger0001",
            Some(json!({"sequenceNum": 3, "revision": "rev-3"})),
            packed("stranger0001", &body_update("forged"), &stranger_key),
        ),
    ]);
    let transport = FakeTransport::new(vec![
        response(200, &listing(40)),
        bytes_response(pack_bytes),
        // The bodies pass: the probe advertises the revision the pack seeded,
        // so §7.8 takes no baseline and only the update page is fetched.
        response(
            200,
            &json!({
                "notes": {NOTE: {"updates": [], "hasMore": false}},
                "snapshotMeta": {NOTE: {"sequenceNum": 7, "revision": "rev-7"}}
            })
            .to_string(),
        ),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]);
    let http = http(transport.clone());
    let bodies = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory {
            device_id: "device-a".into(),
            public_key,
        }),
    ));

    let report = PackBootstrap::new(Arc::clone(&http), db.clone(), Arc::clone(&bodies))
        .run(1_000)
        .await
        .expect("the pack bootstrap");

    assert_eq!(report.packs_applied, 1);
    assert_eq!(report.entries_applied, 1);
    assert_eq!(report.entries_skipped, 1);
    assert_eq!(report.entries_failed, 1);
    assert_eq!(report.applied_through_cursor, Some(40));
    assert_eq!(text_of(&db, NOTE), "Hello from a pack");
    assert_eq!(cursor_of(&db, NOTE).as_deref(), Some("7"));
    assert_eq!(cursor_of(&db, "stranger0001"), None);
    assert!(
        transport.calls_to("/packs/r1").is_empty(),
        "record packs are not fetched"
    );
    let watermark = db
        .call_blocking(|conn| read_meta(conn, META_PACKS_APPLIED_THROUGH))
        .expect("meta");
    assert_eq!(watermark.as_deref(), Some("40"));

    let pulled = bodies.pull_document(NOTE).await.expect("the body pull");
    assert_eq!(pulled.baselines, 0);
    assert!(
        transport
            .calls()
            .iter()
            .all(|call| !call.url.contains("/sync/crdt/snapshot/")),
        "a seeded note costs no snapshot GET"
    );
}

#[tokio::test]
async fn a_resumed_run_skips_packs_at_or_below_the_watermark() {
    let db = scratch_db("resume");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, '40')",
            [META_PACKS_APPLIED_THROUGH],
        )
        .map(|_| ())
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("seed the watermark");
    // Only the listing is scripted: a download would panic as unscripted.
    let transport = FakeTransport::new(vec![response(200, &listing(40))]);
    let report = bootstrap(&db, transport).run(1_000).await.expect("run");
    assert_eq!(report.packs_applied, 0);
    assert_eq!(report.applied_through_cursor, None);
}

/// iOS suspends a first sync mid-run. Packs go newest first, so the
/// contiguity watermark cannot cover a newer pack until the oldest finishes;
/// a pack that did finish must not be downloaded again on resume.
#[tokio::test]
async fn a_resumed_run_does_not_redownload_a_pack_finished_before_suspension() {
    let db = scratch_db("suspend");
    let two_packs = json!({
        "packs": [
            {"id": "new", "itemKind": "crdt_snapshot", "maxCursor": 80,
             "url": "https://r2.example/packs/new", "expiresAt": 4_000_000_000i64},
            {"id": "old", "itemKind": "crdt_snapshot", "maxCursor": 40,
             "url": "https://r2.example/packs/old", "expiresAt": 4_000_000_000i64}
        ]
    })
    .to_string();
    let empty = || mpak(&[(NOTE, None, vec![1])]);

    // First run: the newest pack lands, then the run is cut off before the
    // oldest one (here: its download is refused).
    let transport = FakeTransport::new(vec![
        response(200, &two_packs),
        bytes_response(empty()),
        response(403, r#"{"error":"denied"}"#),
    ]);
    let report = bootstrap(&db, transport).run(1_000).await.expect("run");
    assert_eq!(report.packs_applied, 1);
    assert_eq!(report.applied_through_cursor, None);

    // Resume: only the oldest pack is scripted; re-fetching `new` panics.
    let transport = FakeTransport::new(vec![response(200, &two_packs), bytes_response(empty())]);
    let report = bootstrap(&db, transport.clone())
        .run(1_000)
        .await
        .expect("run");
    assert!(transport.calls_to("/packs/new").is_empty());
    assert_eq!(report.packs_applied, 1);
    assert_eq!(report.applied_through_cursor, Some(80));
}

#[tokio::test]
async fn an_old_server_or_a_corrupt_pack_falls_back_without_a_watermark() {
    let db = scratch_db("fallback");
    let transport = FakeTransport::new(vec![response(404, r#"{"error":"not found"}"#)]);
    let report = bootstrap(&db, transport).run(1_000).await.expect("run");
    assert_eq!(report.packs_applied, 0);
    assert_eq!(report.fallback_reasons.len(), 1);

    let mut corrupt = mpak(&[(
        NOTE,
        Some(json!({"sequenceNum": 1, "revision": "r"})),
        vec![1, 2, 3],
    )]);
    corrupt[9] ^= 0xFF;
    let transport = FakeTransport::new(vec![response(200, &listing(40)), bytes_response(corrupt)]);
    let report = bootstrap(&db, transport).run(1_000).await.expect("run");
    assert_eq!(report.packs_applied, 0);
    assert_eq!(report.applied_through_cursor, None);
    assert_eq!(cursor_of(&db, NOTE), None);
    let watermark = db
        .call_blocking(|conn| read_meta(conn, META_PACKS_APPLIED_THROUGH))
        .expect("meta");
    assert_eq!(watermark, None);
}

fn bootstrap(db: &Db, transport: Arc<FakeTransport>) -> PackBootstrap {
    let http = http(transport);
    let bodies = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory {
            device_id: "device-a".into(),
            public_key: vec![0; 32],
        }),
    ));
    PackBootstrap::new(http, db.clone(), bodies)
}

/// Serves a listing of five packs and answers each download after a second, counting how many
/// downloads are in flight at once.
struct SlowPacks {
    in_flight: std::sync::atomic::AtomicUsize,
    most: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl memry_core::seams::transport::Transport for SlowPacks {
    async fn send(
        &self,
        request: memry_core::seams::transport::HttpRequest,
    ) -> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError>
    {
        use std::sync::atomic::Ordering::SeqCst;
        if request.url.contains("/sync/packs") {
            let packs: Vec<Json> = (1..=5)
                .map(|n| {
                    json!({"id": format!("p{n}"), "itemKind": "crdt_snapshot", "maxCursor": n * 10,
                           "url": format!("https://r2.example/packs/p{n}"),
                           "expiresAt": 4_000_000_000i64})
                })
                .collect();
            return response(200, &json!({ "packs": packs }).to_string());
        }
        let now = self.in_flight.fetch_add(1, SeqCst) + 1;
        self.most.fetch_max(now, SeqCst);
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        self.in_flight.fetch_sub(1, SeqCst);
        bytes_response(mpak(&[(NOTE, None, vec![1])]))
    }

    fn open_socket(
        &self,
        _request: memry_core::seams::transport::SocketRequest,
        _listener: Arc<dyn memry_core::seams::transport::SocketListener>,
    ) -> Result<
        Arc<dyn memry_core::seams::transport::SocketHandle>,
        memry_core::api::errors::TransportError,
    > {
        Err(memry_core::api::errors::TransportError::Failed {
            what: "no sockets here".into(),
        })
    }
}

/// Desktop's `with_concurrency(3)`: three packs download at once and never more, and every pack
/// still lands with the watermark over all five.
#[tokio::test(start_paused = true)]
async fn a_concurrent_bootstrap_downloads_three_packs_at_once() {
    let db = scratch_db("concurrent");
    let server = Arc::new(SlowPacks {
        in_flight: Default::default(),
        most: Default::default(),
    });
    let http = Arc::new(HttpClient::new(
        server.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    ));
    let bodies = Arc::new(BodyPull::new(
        Arc::clone(&http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(Directory {
            device_id: "device-a".into(),
            public_key: vec![0; 32],
        }),
    ));
    let report = PackBootstrap::new(http, db.clone(), bodies)
        .with_concurrency(3)
        .run(1_000)
        .await
        .expect("run");
    assert_eq!(server.most.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(report.packs_applied, 5);
    assert_eq!(report.applied_through_cursor, Some(50));
}

/// Records every `bodies_applied` call with the document's `crdt:` cursor as a fresh read saw it.
struct BodyWatcher {
    db: Db,
    heard: std::sync::Mutex<Vec<(Vec<String>, Option<String>)>>,
}

impl ApplyObserver for BodyWatcher {
    fn name(&self) -> &str {
        "body-watcher"
    }

    fn bodies_applied(&self, doc_ids: &[String]) {
        let cursor = cursor_of(&self.db, &doc_ids[0]);
        self.heard.lock().unwrap().push((doc_ids.to_vec(), cursor));
    }
}

/// `bodies_applied` names a document once its body change has committed: a packed snapshot that
/// applied, then a pulled update. A refused or untrusted pack entry and a pull that stored nothing
/// tell no one.
#[tokio::test]
async fn a_seeded_or_pulled_body_is_told_to_the_observers_after_it_commits() {
    let db = scratch_db("observers");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
    let (_, stranger_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[8u8; 32]).expect("keypair");
    let pack_bytes = mpak(&[
        (
            NOTE,
            Some(json!({"sequenceNum": 7, "revision": "rev-7"})),
            packed(NOTE, &body_update("Hello from a pack"), &secret_key),
        ),
        (
            "nometa000001",
            None,
            packed("nometa000001", &body_update("x"), &secret_key),
        ),
        (
            "stranger0001",
            Some(json!({"sequenceNum": 3, "revision": "rev-3"})),
            packed("stranger0001", &body_update("forged"), &stranger_key),
        ),
    ]);
    let update = BASE64.encode(packed(NOTE, &body_update("Edited"), &secret_key));
    let probe = json!({
        "notes": {NOTE: {"updates": [], "hasMore": false}},
        "snapshotMeta": {NOTE: {"sequenceNum": 7, "revision": "rev-7"}}
    })
    .to_string();
    let transport = FakeTransport::new(vec![
        response(200, &listing(40)),
        bytes_response(pack_bytes),
        response(200, &probe),
        response(
            200,
            &json!({"updates": [{"sequenceNum": 8, "data": update, "signerDeviceId": "device-a"}],
                    "hasMore": false})
            .to_string(),
        ),
        response(200, &probe),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]);
    let http = http(transport);
    let observers = Arc::new(Observers::default());
    let watcher = Arc::new(BodyWatcher {
        db: db.clone(),
        heard: std::sync::Mutex::default(),
    });
    observers.register(watcher.clone());
    let bodies = Arc::new(
        BodyPull::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            Arc::new(Directory {
                device_id: "device-a".into(),
                public_key,
            }),
        )
        .with_observers(observers),
    );

    PackBootstrap::new(Arc::clone(&http), db.clone(), Arc::clone(&bodies))
        .run(1_000)
        .await
        .expect("the pack bootstrap");
    assert_eq!(
        *watcher.heard.lock().unwrap(),
        [(vec![NOTE.to_owned()], Some("7".to_owned()))],
        "only the applied pack entry, after its baseline committed"
    );

    let pulled = bodies.pull_document(NOTE).await.expect("the body pull");
    assert_eq!(pulled.updates, 1);
    let quiet = bodies
        .pull_document(NOTE)
        .await
        .expect("a pull with nothing new");
    assert_eq!(quiet.updates + quiet.baselines, 0);
    assert_eq!(
        *watcher.heard.lock().unwrap(),
        [
            (vec![NOTE.to_owned()], Some("7".to_owned())),
            (vec![NOTE.to_owned()], Some("8".to_owned())),
        ],
        "the pulled update once, after it committed; the empty pull tells no one"
    );
}
