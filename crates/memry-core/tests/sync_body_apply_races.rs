//! The bulk body apply against writes that land beside it, and against
//! desktop's yjs (#5231).
//!
//! A pack chunk reads freshness, verifies on the blocking pool, then writes.
//! A tombstone, a body pull or a newer baseline can land between the read and
//! the write; the write transaction checks again, and these tests hold that.
//! The last test seeds and pulls a body desktop wrote with yjs through the
//! chunk paths and the real crypto, and checks it converges with desktop's
//! document (`tests/fixtures/desktop_yjs_body.gen.mjs` makes the fixture).

mod http_fakes;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::crdt::update_log;
use memry_core::crypto::sodium;
use memry_core::protocol::crdt_envelope::{self, CrdtMaterial, CrdtRequest};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackEntrySeed, PackSeed, PackedUpdate};
use memry_core::sync::store;
use serde_json::{Value as Json, json};
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{GetString as _, ReadTxn as _, StateVector, Transact as _, Update};

const DOC: &str = "racedoc00001";

type Interleave = Box<dyn FnOnce(&Db) + Send>;

/// Passes the bytes through, and runs `interleave` inside the first open:
/// after the chunk's freshness read and before its write transaction.
struct Interleaving {
    db: Db,
    interleave: Mutex<Option<Interleave>>,
}

impl CrdtCipher for Interleaving {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if let Some(interleave) = self.interleave.lock().expect("the hook").take() {
            interleave(&self.db);
        }
        Ok(update.packed.to_vec())
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec!["device-a".into()]
    }
}

fn scratch(label: &str) -> Db {
    // Kept on disk: the database outlives this function.
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-body-race-{label}-"))
        .tempdir()
        .expect("create the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn body_pull(db: &Db, cipher: Arc<dyn CrdtCipher>, script: Vec<String>) -> BodyPull {
    let http = Arc::new(HttpClient::new(
        FakeTransport::new(script.iter().map(|body| response(200, body)).collect()),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    BodyPull::new(http, db.clone(), Declaration::subscribed(), cipher)
}

fn cursor(db: &Db, doc_id: &str) -> Option<String> {
    let scope = format!("crdt:{doc_id}");
    db.call_blocking(move |conn| store::read_cursor(conn, &scope))
        .expect("the cursor")
}

fn snapshot(db: &Db) -> Option<Vec<u8>> {
    db.call_blocking(|conn| {
        Ok(
            update_log::snapshot(conn, update_log::Namespace::Server, DOC)
                .expect("the snapshot")
                .map(|row| row.snapshot),
        )
    })
    .expect("read the snapshot")
}

/// Seeds one packed baseline at sequence 5 with `interleave` run between the
/// chunk's read and its write.
async fn seed_with(label: &str, interleave: Interleave) -> (Db, PackSeed) {
    let db = scratch(label);
    let cipher = Arc::new(Interleaving {
        db: db.clone(),
        interleave: Mutex::new(Some(interleave)),
    });
    let seeds = [PackEntrySeed {
        doc_id: DOC,
        packed: b"PACKED-OLD",
        sequence_num: 5,
        revision: "rev-pack",
    }];
    let seeded = body_pull(&db, cipher, Vec::new())
        .seed_pack_chunk(&seeds)
        .await
        .expect("the seed");
    (db, seeded[0])
}

/// §7.15: a document deleted while its chunk verified gets no body.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_document_deleted_mid_chunk_is_not_seeded() {
    let (db, seeded) = seed_with(
        "deleted",
        Box::new(|db| {
            db.call_blocking(|conn| {
                conn.execute(
                    "INSERT INTO sync_items (item_type, item_id, payload_state, updated_at, deleted_at)
                     VALUES ('note', ?1, 'tombstone', 1, 1)",
                    [DOC],
                )
                .expect("the tombstone");
                Ok(())
            })
            .expect("delete the document");
        }),
    )
    .await;
    assert_ne!(seeded, PackSeed::Applied);
    assert_eq!(snapshot(&db), None, "no body for a deleted document");
    assert_eq!(cursor(&db, DOC), None);
}

/// A newer baseline a body pull stored mid-chunk is never overwritten by the
/// older packed one, and its cursor never moves back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newer_baseline_stored_mid_chunk_is_kept() {
    let (db, seeded) = seed_with(
        "newer",
        Box::new(|db| {
            db.call_blocking(|conn| {
                update_log::put_server_snapshot(conn, DOC, b"NEWER", 10, Some("rev-new"), 1)
                    .expect("the newer snapshot");
                store::write_cursor(conn, &format!("crdt:{DOC}"), Some("10"), 1)
            })
            .expect("store the newer baseline");
        }),
    )
    .await;
    assert_eq!(seeded, PackSeed::Stale);
    assert_eq!(snapshot(&db).as_deref(), Some(&b"NEWER"[..]));
    assert_eq!(cursor(&db, DOC).as_deref(), Some("10"));
}

/// Updates a body pull stored mid-chunk keep their cursor, and the older
/// baseline is not laid under them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn updates_pulled_mid_chunk_are_not_shadowed_by_an_older_baseline() {
    let (db, seeded) = seed_with(
        "updates",
        Box::new(|db| {
            db.call_blocking(|conn| {
                for seq in 1..=7 {
                    update_log::append_server_update(conn, DOC, seq, b"u", 1).expect("an update");
                }
                store::write_cursor(conn, &format!("crdt:{DOC}"), Some("7"), 1)
            })
            .expect("store the updates");
        }),
    )
    .await;
    assert_eq!(seeded, PackSeed::Stale);
    assert_eq!(snapshot(&db), None);
    assert_eq!(cursor(&db, DOC).as_deref(), Some("7"));
}

/// The production open: chapter 04 §4.12 against one desktop device.
struct DesktopCipher {
    vault_key: Vec<u8>,
    public_key: Vec<u8>,
}

impl CrdtCipher for DesktopCipher {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        crdt_envelope::unpack(
            update.packed,
            update.doc_id,
            &self.vault_key,
            &self.public_key,
        )
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec!["desktop".into()]
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

/// Desktop's snapshot (sequence 5) seeded from a pack, its 105 updates pulled
/// as a full page and a short one, then one more desktop edit: the core's
/// document reads desktop's text and holds desktop's state vector.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bulk_applied_body_converges_with_a_desktop_edit() {
    let fixture: Json =
        serde_json::from_str(include_str!("fixtures/desktop_yjs_body.json")).expect("the fixture");
    let field = |name: &str| hex(fixture[name].as_str().expect(name));
    let updates: Vec<Vec<u8>> = fixture["updates"]
        .as_array()
        .expect("updates")
        .iter()
        .map(|update| hex(update.as_str().expect("an update")))
        .collect();
    let doc = "conv00000001";

    let vault_key = sodium::random_bytes(32);
    let (public_key, secret_key) = sodium::sign_keypair().expect("a keypair");
    let seal = |update: &[u8]| {
        crdt_envelope::pack(
            &CrdtRequest {
                note_id: doc,
                update,
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("seal")
    };
    let cipher: Arc<dyn CrdtCipher> = Arc::new(DesktopCipher {
        vault_key: vault_key.clone(),
        public_key,
    });
    let db = scratch("converge");

    let packed = seal(&field("snapshot"));
    let seeds = [PackEntrySeed {
        doc_id: doc,
        packed: &packed,
        sequence_num: 5,
        revision: "rev-5",
    }];
    let seeded = body_pull(&db, Arc::clone(&cipher), Vec::new())
        .seed_pack_chunk(&seeds)
        .await
        .expect("the seed");
    assert_eq!(seeded, vec![PackSeed::Applied]);

    let page = |from: i64, list: &[Vec<u8>], more: bool| {
        let entries: Vec<Json> = list
            .iter()
            .enumerate()
            .map(|(at, update)| {
                json!({
                    "sequenceNum": from + at as i64,
                    "data": BASE64.encode(seal(update)),
                    "signerDeviceId": "desktop",
                })
            })
            .collect();
        json!({ "updates": entries, "hasMore": more }).to_string()
    };
    // The probe of a document holding a cursor: an old server's answer.
    let probe = json!({ "notes": {} }).to_string();
    let pulled = body_pull(
        &db,
        Arc::clone(&cipher),
        vec![
            probe.clone(),
            page(6, &updates[..100], true),
            page(106, &updates[100..], false),
        ],
    )
    .pull_document(doc)
    .await
    .expect("the bulk pull");
    assert!(pulled.merged());
    assert_eq!(pulled.updates, updates.len());

    let edit_seq = 6 + updates.len() as i64;
    let edited = body_pull(
        &db,
        Arc::clone(&cipher),
        vec![probe, page(edit_seq, &[field("edit")], false)],
    )
    .pull_document(doc)
    .await
    .expect("the edit pull");
    assert_eq!(edited.updates, 1);
    assert_eq!(cursor(&db, doc), Some(edit_seq.to_string()));

    let id = doc.to_owned();
    let blobs: Vec<Vec<u8>> = db
        .call_blocking(move |conn| {
            let plan = update_log::load_plan(conn, &id).expect("the load plan");
            Ok(plan.blobs().into_iter().map(<[u8]>::to_vec).collect())
        })
        .expect("load the body");
    let ydoc = yrs::Doc::new();
    {
        let mut txn = ydoc.transact_mut();
        for blob in &blobs {
            txn.apply_update(Update::decode_v1(blob).expect("an update"))
                .expect("apply");
        }
    }
    let text = ydoc.get_or_insert_text("t");
    let txn = ydoc.transact();
    assert_eq!(
        text.get_string(&txn),
        fixture["text"].as_str().expect("text")
    );
    assert_eq!(txn.state_vector().encode_v1(), field("sv"));
    let before = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let desktop = Update::decode_v1(&field("state")).expect("desktop's state");
    ydoc.transact_mut()
        .apply_update(desktop)
        .expect("apply desktop's state");
    assert_eq!(
        ydoc.get_or_insert_text("t").get_string(&ydoc.transact()),
        fixture["text"].as_str().expect("text"),
        "desktop's full state adds nothing the core lacks"
    );
    assert_eq!(
        ydoc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
        before
    );
}
