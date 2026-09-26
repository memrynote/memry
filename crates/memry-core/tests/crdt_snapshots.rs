//! Snapshot push, the client obligation and the local prune, against real
//! adapters (chapter 07 §7.6, §7.13; chapter 12 §12.5.1).
//!
//! Real `yrs`, real SQLite, real chapter 04 §4.11 packing. The only fake is
//! the `Transport`.
//!
//! | Test                                   | Rule                        |
//! | -------------------------------------- | --------------------------- |
//! | a foreign root survives the round trip | chapter 12 §12.5.1, FR-033  |
//! | each gate condition refuses            | §7.13.2, all three          |
//! | the watermark does not walk forward    | §7.6                        |
//! | the local prune follows the store      | §7.7 (the client's half)    |
//! | a pushed snapshot stores a NULL revision | §7.13.4, until #2187      |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::snapshots::{
    Refusal, SnapshotGate, SnapshotOutcome, SnapshotPusher, SnapshotSealer,
};
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{Document, DocumentRegistry};
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack, unpack};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use serde_json::json;
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, Map as _, ReadTxn as _, StateVector, Transact as _, Update, XmlTextPrelim};
use yrs::{XmlFragment as _, XmlOut};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";
const VAULT_KEY: [u8; 32] = [5u8; 32];

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-snapshots-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// The real §7.11 sealing: **the identical packed envelope an update travels
/// in**, and no separate snapshot shape.
struct RealSealer {
    secret_key: Vec<u8>,
}

impl SnapshotSealer for RealSealer {
    fn seal_snapshot(&self, doc_id: &str, state: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        pack(
            &CrdtRequest {
                note_id: doc_id,
                update: state,
                vault_key: &VAULT_KEY,
                signing_secret_key: &self.secret_key,
            },
            &CrdtMaterial::random(),
        )
    }
}

fn pusher(db: &Db, transport: Arc<FakeTransport>, secret_key: Vec<u8>) -> SnapshotPusher {
    let http = Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    SnapshotPusher::new(
        http,
        db.clone(),
        Arc::new(RealSealer { secret_key }),
        Declaration::subscribed(),
    )
}

fn open_document(doc_id: &str) -> (DocumentRegistry, Arc<Document>) {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-a", sink);
    let document = registry.get_or_open(doc_id).expect("open");
    (registry, document)
}

/// A full-state update carrying both a body and a root this build has never
/// heard of — the negative control of chapter 12 §12.5.1.
fn update_with_a_foreign_root() -> Vec<u8> {
    let author = Doc::with_client_id(99);
    let foreign = author.get_or_insert_map("someFutureRoot");
    let body = author.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = author.transact_mut();
        foreign.insert(&mut txn, "kept", "yes");
        body.insert(&mut txn, 0, XmlTextPrelim::new("body"));
    }
    author
        .transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn stored_snapshot(db: &Db, doc_id: &str) -> update_log::SnapshotRow {
    let id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        update_log::snapshot(conn, Namespace::Server, &id).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("read")
    .expect("a stored snapshot")
}

// ----------------------------------------------------------------- the tests

#[tokio::test]
async fn a_pushed_snapshot_carries_a_root_this_build_never_names() {
    let db = scratch_db("unknown-root");
    let (public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair");
    let (_registry, document) = open_document(NOTE);
    document
        .apply_durable_update(&update_with_a_foreign_root())
        .expect("apply");

    let transport =
        FakeTransport::new(vec![response(200, &json!({"sequenceNum": 12}).to_string())]);
    let outcome = pusher(&db, transport.clone(), secret_key.to_vec())
        .push(&document, SnapshotGate::clean(), 1_000)
        .await
        .expect("the push");
    assert!(matches!(
        outcome,
        SnapshotOutcome::Pushed {
            sequence_num: 12,
            ..
        }
    ));

    // What went on the wire is the full-state encode, sealed in §7.11's
    // packed envelope, and it still carries the root.
    let sent = http_fakes::body_json(&transport.calls_to("/sync/crdt/snapshot")[0]);
    assert_eq!(sent["noteId"], NOTE);
    let packed = BASE64
        .decode(sent["snapshot"].as_str().expect("a base64 snapshot"))
        .expect("base64");
    let state = unpack(&packed, NOTE, &VAULT_KEY, &public_key).expect("unpack");

    let reader = Doc::new();
    reader
        .transact_mut()
        .apply_update(Update::decode_v1(&state).expect("decode"))
        .expect("apply");
    assert_eq!(
        reader
            .get_or_insert_map("someFutureRoot")
            .get(&reader.transact(), "kept")
            .map(|value| value.to_string(&reader.transact())),
        Some("yes".to_owned()),
        "a snapshot assembled from named roots would have dropped this"
    );
    // And the body is still there, so the control is not vacuous.
    let fragment = reader.get_or_insert_xml_fragment("prosemirror");
    assert!(matches!(
        fragment.get(&reader.transact(), 0),
        Some(XmlOut::Text(_))
    ));

    // The same bytes are what went into `yjs_snapshots`.
    let row = stored_snapshot(&db, NOTE);
    assert_eq!(row.snapshot, state);
    // §7.13.4: NULL, never an invented token.
    assert_eq!(row.server_revision, None);
    assert_eq!(row.last_seq, 12);
}

#[tokio::test]
async fn the_watermark_does_not_move_on_a_second_snapshot_and_the_prune_follows_it() {
    let db = scratch_db("watermark");
    let (_public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[11u8; 32]).expect("keypair");
    let (_registry, document) = open_document(NOTE);
    document
        .apply_durable_update(&update_with_a_foreign_root())
        .expect("apply");

    // Server rows this device has pulled and the resident document holds:
    // three at or below the watermark the server is about to reuse, and two
    // above it.
    let rows: Vec<(i64, Vec<u8>)> = [10i64, 11, 12, 13, 14]
        .into_iter()
        .map(|seq| {
            let peer = Doc::with_client_id(seq as u64);
            let map = peer.get_or_insert_map("pulled");
            map.insert(&mut peer.transact_mut(), format!("row-{seq}"), seq);
            (
                seq,
                peer.transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
        })
        .collect();
    for (_, update) in &rows {
        document.apply_durable_update(update).expect("pulled");
    }
    db.call_blocking(move |conn| {
        for (seq, update) in &rows {
            update_log::append_server_update(conn, NOTE, *seq, update, 1).expect("append");
        }
        Ok(())
    })
    .expect("seed");

    let transport = FakeTransport::new(vec![
        response(200, &json!({"sequenceNum": 12}).to_string()),
        // §7.6: the second write reuses the first's sequence number. A server
        // that answered 14 here would be answering wrongly, and §7.6 is why
        // the client must not believe it either way.
        response(200, &json!({"sequenceNum": 14}).to_string()),
    ]);
    let pusher = pusher(&db, transport, secret_key.to_vec());

    let first = pusher
        .push(&document, SnapshotGate::clean(), 1_000)
        .await
        .expect("first push");
    assert_eq!(
        first,
        SnapshotOutcome::Pushed {
            sequence_num: 12,
            pruned: 3
        },
        "the three rows at or below the watermark are absorbed and removed"
    );

    let second = pusher
        .push(&document, SnapshotGate::clean(), 2_000)
        .await
        .expect("second push");
    assert_eq!(
        second,
        SnapshotOutcome::Pushed {
            sequence_num: 12,
            pruned: 0
        },
        "§7.6: the watermark stays put, so the incrementals above it stay pullable"
    );

    // 13 and 14 survived both pushes and are still what `load_plan` hands a
    // loader after the snapshot.
    let plan = db
        .call_blocking(|conn| {
            update_log::load_plan(conn, NOTE).map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("plan");
    assert_eq!(
        plan.server_updates
            .iter()
            .map(|row| row.seq)
            .collect::<Vec<_>>(),
        vec![13, 14]
    );
}

#[tokio::test]
async fn every_condition_of_the_gate_refuses_before_the_endpoint_is_called() {
    let db = scratch_db("gate");
    let (_public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[13u8; 32]).expect("keypair");
    let (_registry, document) = open_document(NOTE);

    // A transport with an empty script: any request at all panics, which is
    // exactly the assertion "the endpoint was not called".
    let pusher = pusher(&db, FakeTransport::new(vec![]), secret_key.to_vec());

    // Condition 3, on a document with nothing in it. Checked first because a
    // fresh document is the one shape a caller is most likely to push by
    // accident.
    assert_eq!(
        pusher
            .push(&document, SnapshotGate::clean(), 1)
            .await
            .expect("empty"),
        SnapshotOutcome::Refused(Refusal::EmptyState)
    );

    document
        .apply_durable_update(&update_with_a_foreign_root())
        .expect("apply");

    // Condition 1: the last pull ended holding debt.
    let unmerged = SnapshotGate {
        pull_completed_clean: false,
        ..SnapshotGate::clean()
    };
    assert_eq!(
        pusher.push(&document, unmerged, 1).await.expect("unmerged"),
        SnapshotOutcome::Refused(Refusal::UnmergedRemoteState)
    );

    // Condition 2, both halves.
    let local_only = SnapshotGate {
        local_only: true,
        ..SnapshotGate::clean()
    };
    assert_eq!(
        pusher.push(&document, local_only, 1).await.expect("local"),
        SnapshotOutcome::Refused(Refusal::LocalOnly)
    );
    let purged = SnapshotGate {
        purged: true,
        ..SnapshotGate::clean()
    };
    assert_eq!(
        pusher.push(&document, purged, 1).await.expect("purged"),
        SnapshotOutcome::Refused(Refusal::Purged)
    );

    // Nothing was written either: a refused document must not look
    // snapshotted locally.
    let row = db
        .call_blocking(|conn| {
            update_log::snapshot(conn, Namespace::Server, NOTE).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("read");
    assert!(row.is_none());
}

/// #2294, #2297: a document owed a whole-body pull has not merged what a
/// snapshot would prune, so the push refuses it even behind a clean gate, and
/// pushes again once the debt is settled.
#[tokio::test]
async fn a_document_owed_a_body_pull_refuses_the_snapshot_push() {
    let db = scratch_db("owed");
    let (_public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[17u8; 32]).expect("keypair");
    let (_registry, document) = open_document(NOTE);
    document
        .apply_durable_update(&update_with_a_foreign_root())
        .expect("apply");
    db.call_blocking(|conn| memry_core::sync::body_debt::owe(conn, NOTE))
        .expect("owe");

    let refused = pusher(&db, FakeTransport::new(vec![]), secret_key.to_vec());
    assert_eq!(
        refused
            .push(&document, SnapshotGate::clean(), 1)
            .await
            .expect("owed"),
        SnapshotOutcome::Refused(Refusal::UnmergedRemoteState)
    );

    db.call_blocking(|conn| memry_core::sync::body_debt::settle(conn, NOTE))
        .expect("settle");
    let transport = FakeTransport::new(vec![response(200, &json!({"sequenceNum": 3}).to_string())]);
    let pushed = pusher(&db, transport.clone(), secret_key.to_vec())
        .push(&document, SnapshotGate::clean(), 1)
        .await
        .expect("settled");
    assert!(
        matches!(pushed, SnapshotOutcome::Pushed { .. }),
        "{pushed:?}"
    );
    assert_eq!(transport.call_count(), 1);
}

/// #2297 review A-6/B-10: a settled debt means the update is in the log, not
/// in the document open in memory. A feed page can land an update while the
/// document is resident, so the push refuses until the document holds every
/// logged update, and pushes once it does.
#[tokio::test]
async fn a_resident_document_behind_its_log_refuses_the_snapshot_push() {
    let db = scratch_db("behind-log");
    let (_public_key, secret_key) =
        memry_core::crypto::sodium::sign_seed_keypair(&[19u8; 32]).expect("keypair");
    let (_registry, document) = open_document(NOTE);
    document
        .apply_durable_update(&update_with_a_foreign_root())
        .expect("apply");

    let peer = Doc::with_client_id(77);
    let body = peer.get_or_insert_xml_fragment("prosemirror");
    body.insert(
        &mut peer.transact_mut(),
        0,
        XmlTextPrelim::new("from the feed"),
    );
    let landed = peer
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let logged = landed.clone();
    db.call_blocking(move |conn| {
        update_log::append_server_update(conn, NOTE, 1, &logged, 1).map_err(|error| {
            StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .expect("a feed landing");

    let refused = pusher(&db, FakeTransport::new(vec![]), secret_key.to_vec());
    assert_eq!(
        refused
            .push(&document, SnapshotGate::clean(), 1)
            .await
            .expect("behind"),
        SnapshotOutcome::Refused(Refusal::UnmergedRemoteState)
    );

    document.apply_durable_update(&landed).expect("the reload");
    let transport = FakeTransport::new(vec![response(200, &json!({"sequenceNum": 3}).to_string())]);
    let pushed = pusher(&db, transport.clone(), secret_key.to_vec())
        .push(&document, SnapshotGate::clean(), 1)
        .await
        .expect("caught up");
    assert!(
        matches!(pushed, SnapshotOutcome::Pushed { .. }),
        "{pushed:?}"
    );
}
