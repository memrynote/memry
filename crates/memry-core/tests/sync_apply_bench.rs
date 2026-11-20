//! Local apply benchmark for a fresh-device bootstrap (#5231).
//!
//! Seeds a vault of `MEMRY_BENCH_NOTES` notes (default 10,000) as real sealed
//! envelopes and packed CRDT updates, then times the two local halves of a
//! bootstrap with no network in the way:
//!
//! - **records**: [`PullLoop::run`] over scripted `/sync/changes` and
//!   `/sync/pull` responses, with real Ed25519 verify, AEAD and inflate.
//! - **packed bodies**: [`PackBootstrap::run_bodies`] over `crdt_snapshot`
//!   packs holding every note's baseline, confirmed by a body manifest, with
//!   real Ed25519 verify and AEAD.
//! - **pulled bodies**: [`BodyPull::pull_documents`] over scripted
//!   `/sync/crdt/snapshot` and `/sync/crdt/updates` responses for a tenth of
//!   the notes, each with `MEMRY_BENCH_UPDATES` updates (default 10).
//!
//! Fixture generation is outside the timed region. Run it in release:
//!
//! ```text
//! cargo test --release -p memry-core --test sync_apply_bench -- --ignored --nocapture
//! ```

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, bytes_response, mpak, response};
use memry_core::crypto::sodium;
use memry_core::protocol::crdt_envelope::{self, CrdtMaterial, CrdtRequest};
use memry_core::protocol::envelope::{
    self, EnvelopeError, RecordEnvelope, RecordMaterial, RecordRequest, SyncOperation,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::pack::{extract_entry, parse_pack};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::pack_bootstrap::PackBootstrap;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::{Value as Json, json};
use yrs::{ReadTxn as _, StateVector, Text as _, Transact as _};

const SIGNER: &str = "bench-device";
const PAGE: usize = 500;
const PULL_IDS: usize = 100;
/// Entries per pack, under the reader's 4,096 cap (§8.6).
const PACK_ENTRIES: usize = 2_500;

/// The production cipher's work for one record: verify, unwrap, decrypt and
/// inflate. The directory lookup `AccountCipher` adds is one map read.
struct BenchCipher {
    vault_key: Vec<u8>,
    public_key: Vec<u8>,
}

impl RecordCipher for BenchCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        envelope::decrypt(envelope, &self.vault_key, &self.public_key)
    }
}

/// The production body open: verify the signer's key, then AEAD.
struct BenchCrdtCipher {
    vault_key: Vec<u8>,
    public_key: Vec<u8>,
}

impl CrdtCipher for BenchCrdtCipher {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        if update.signer_device_id != Some(SIGNER) {
            return Err(EnvelopeError::SignatureInvalid);
        }
        crdt_envelope::unpack(
            update.packed,
            update.doc_id,
            &self.vault_key,
            &self.public_key,
        )
    }

    fn signer_candidates(&self) -> Vec<String> {
        vec![SIGNER.to_owned()]
    }
}

fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn notes() -> usize {
    env_count("MEMRY_BENCH_NOTES", 10_000)
}

fn scratch_db() -> Db {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("memry-apply-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn note_id(index: usize) -> String {
    format!("n{index:011}")
}

fn note_payload(index: usize) -> String {
    json!({
        "title": format!("Bench note {index}"),
        "tags": ["bench", format!("t{}", index % 50)],
        "folderPath": format!("folder-{}", index % 40),
        "clock": { "remote-device": 3 },
        "createdAt": 1_760_000_000_000_i64 + index as i64,
        "modifiedAt": 1_760_000_100_000_i64 + index as i64,
    })
    .to_string()
}

fn body_update(index: usize) -> Vec<u8> {
    let doc = yrs::Doc::with_client_id(7);
    let text = doc.get_or_insert_text("t");
    text.insert(
        &mut doc.transact_mut(),
        0,
        &format!("Body of note {index}. ").repeat(12),
    );
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

struct Fixture {
    cipher: Arc<BenchCipher>,
    crdt_cipher: Arc<BenchCrdtCipher>,
    script: Vec<String>,
    /// `crdt_snapshot` packs with every note's baseline, oldest first.
    packs: Vec<Vec<u8>>,
    /// The `GET /sync/crdt/manifest` pages confirming every packed baseline.
    manifest: Vec<String>,
    /// The per-document pull of `pulled_docs` documents.
    body_script: Vec<String>,
    pulled_docs: Vec<String>,
}

fn pack_listing(packs: usize) -> String {
    let packs: Vec<Json> = (0..packs)
        .map(|number| {
            json!({
                "id": format!("pack-{number}"), "itemKind": "crdt_snapshot", "packKey": "k",
                "minCursor": number + 1, "maxCursor": number + 1, "itemCount": 1,
                "byteSize": 1, "createdAt": 1,
                "url": format!("https://r2.example/packs/{number}"),
                "expiresAt": 4_000_000_000i64
            })
        })
        .collect();
    json!({ "packs": packs, "serverTime": 1 }).to_string()
}

fn seed(count: usize) -> Fixture {
    let vault_key = sodium::random_bytes(32);
    let (public_key, secret_key) = sodium::sign_keypair().expect("a keypair");
    let mut envelopes: Vec<Json> = Vec::with_capacity(count);
    let mut snapshots: Vec<(String, Option<Json>, Vec<u8>)> = Vec::with_capacity(count);
    let seal_body = |doc_id: &str, update: &[u8]| {
        crdt_envelope::pack(
            &CrdtRequest {
                note_id: doc_id,
                update,
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("pack a body")
    };
    for index in 0..count {
        let id = note_id(index);
        let payload = note_payload(index);
        let sealed = envelope::encrypt(
            &RecordRequest {
                id: &id,
                item_type: "note",
                operation: SyncOperation::Update,
                content: payload.as_bytes(),
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
                signer_device_id: SIGNER,
                clock: None,
                state_vector: None,
                deleted_at: None,
            },
            &RecordMaterial::random(),
        )
        .expect("seal a record");
        let mut item = envelope::to_json(&sealed.envelope);
        item["serverCursor"] = json!(index as i64 + 1);
        envelopes.push(item);
        let packed = seal_body(&id, &body_update(index));
        let meta = json!({ "sequenceNum": 1, "revision": format!("rev-{index}") });
        snapshots.push((id, Some(meta), packed));
    }

    let updates = env_count("MEMRY_BENCH_UPDATES", 10);
    let pulled_docs: Vec<String> = (0..count / 10).map(|i| format!("u{i:011}")).collect();
    let mut body_script = Vec::new();
    for doc_id in &pulled_docs {
        // §7.8: cursor 0 asks for a snapshot first; none exists.
        body_script.push(json!({ "snapshot": null }).to_string());
        let entries: Vec<Json> = (1..=updates)
            .map(|seq| {
                let packed = seal_body(doc_id, &body_update(seq));
                json!({
                    "sequenceNum": seq,
                    "data": BASE64.encode(packed),
                    "signerDeviceId": SIGNER,
                })
            })
            .collect();
        body_script.push(json!({ "updates": entries, "hasMore": false }).to_string());
    }

    let mut script = Vec::new();
    let pages = envelopes.chunks(PAGE).collect::<Vec<_>>();
    for (number, page) in pages.iter().enumerate() {
        let refs: Vec<Json> = page
            .iter()
            .map(|item| json!({ "id": item["id"], "type": "note" }))
            .collect();
        let next = page.last().map(|item| item["serverCursor"].clone());
        script.push(
            json!({
                "items": refs,
                "deleted": [],
                "hasMore": number + 1 < pages.len(),
                "nextCursor": next.map(|cursor| cursor.to_string()),
            })
            .to_string(),
        );
        for chunk in page.chunks(PULL_IDS) {
            script.push(json!({ "items": chunk }).to_string());
        }
    }

    Fixture {
        cipher: Arc::new(BenchCipher {
            vault_key: vault_key.clone(),
            public_key: public_key.clone(),
        }),
        crdt_cipher: Arc::new(BenchCrdtCipher {
            vault_key: vault_key.clone(),
            public_key: public_key.clone(),
        }),
        script,
        packs: snapshots
            .chunks(PACK_ENTRIES)
            .map(|chunk| {
                let entries: Vec<_> = chunk
                    .iter()
                    .map(|(id, meta, packed)| (id.as_str(), meta.clone(), packed.clone()))
                    .collect();
                mpak(&entries)
            })
            .collect(),
        manifest: snapshots
            .chunks(1000)
            .enumerate()
            .map(|(page, chunk)| {
                let documents: Vec<Json> = chunk
                    .iter()
                    .map(|(id, meta, _)| {
                        json!({ "noteId": id, "floor": 0, "maxSequenceNum": 0,
                                "snapshot": meta })
                    })
                    .collect();
                let last = (page + 1) * 1000 >= snapshots.len();
                let next = chunk.last().map(|(id, _, _)| id.clone()).filter(|_| !last);
                json!({ "documents": documents, "nextCursor": next }).to_string()
            })
            .collect(),
        body_script,
        pulled_docs,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: run in release with --ignored --nocapture"]
async fn bench_local_apply_of_a_seeded_vault() {
    let count = notes();
    let fixture = seed(count);
    let db = scratch_db();

    let transport = FakeTransport::new(
        fixture
            .script
            .iter()
            .map(|body| response(200, body))
            .collect(),
    );
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        fixture.cipher.clone(),
    );

    let envelopes: Vec<RecordEnvelope> = fixture
        .script
        .iter()
        .filter_map(|body| serde_json::from_str::<Json>(body).ok())
        .filter(|page| page.get("hasMore").is_none())
        .flat_map(|page| page["items"].as_array().cloned().unwrap_or_default())
        .map(|item| envelope::from_json(&item).expect("an envelope"))
        .collect();
    let started = Instant::now();
    for sealed in &envelopes {
        fixture.cipher.open(sealed).expect("open a record");
    }
    let crypto = started.elapsed();

    let started = Instant::now();
    for bytes in &fixture.packs {
        let pack = parse_pack(bytes).expect("a pack");
        for entry in &pack.entries {
            let packed = extract_entry(bytes, entry).expect("an entry");
            fixture
                .crdt_cipher
                .open(&PackedUpdate {
                    doc_id: &entry.id,
                    signer_device_id: Some(SIGNER),
                    packed,
                })
                .expect("open a packed body");
        }
    }
    let body_crypto = started.elapsed();

    let started = Instant::now();
    let report = pull.run(u32::MAX).await.expect("the pull");
    let records = started.elapsed();
    assert_eq!(report.applied, count, "every record applied");
    assert_eq!(report.corrupt, 0);

    let bodies = |transport: Arc<FakeTransport>| {
        let http = Arc::new(HttpClient::new(
            transport,
            "https://sync.example",
            ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
        ));
        let pull = Arc::new(BodyPull::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            fixture.crdt_cipher.clone(),
        ));
        (http, pull)
    };

    // The bootstrap downloads the newest pack (highest `maxCursor`) first.
    let mut script = vec![response(200, &pack_listing(fixture.packs.len()))];
    script.extend(fixture.packs.iter().rev().cloned().map(bytes_response));
    script.extend(fixture.manifest.iter().map(|page| response(200, page)));
    let (http, pull) = bodies(FakeTransport::new(script));
    let started = Instant::now();
    let spill =
        std::env::temp_dir().join(format!("memry-apply-bench-spill-{}", std::process::id()));
    let packed = PackBootstrap::new(http, db.clone(), pull)
        .with_spill_dir(spill)
        .run_bodies(1_000, &|_, _| {})
        .await
        .expect("the pack bootstrap");
    let packs = started.elapsed();
    assert_eq!(packed.snapshots_applied, count, "every packed body seeded");

    let (_, pull) = bodies(FakeTransport::new(
        fixture
            .body_script
            .iter()
            .map(|body| response(200, body))
            .collect(),
    ));
    let started = Instant::now();
    let pulled = pull
        .pull_documents(&fixture.pulled_docs)
        .await
        .expect("the body pull");
    let pulled_time = started.elapsed();
    assert!(pulled.merged(), "every pulled document reached its head");
    let pulled_updates = pulled.updates;

    let stored: i64 = db
        .call(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
                .expect("count"))
        })
        .await
        .expect("count notes");
    assert_eq!(stored as usize, count);

    let ms = |total: std::time::Duration| total.as_secs_f64() * 1000.0;
    println!(
        "apply-bench notes={count} record_crypto_ms={:.0} records_ms={:.0} ms_per_record={:.4} \
         packed_body_crypto_ms={:.0} packed_bodies_ms={:.0} ms_per_packed_body={:.4} pulled_docs={} pulled_updates={pulled_updates} \
         pulled_ms={:.0} ms_per_pulled_update={:.4}",
        ms(crypto),
        ms(records),
        ms(records) / count as f64,
        ms(body_crypto),
        ms(packs),
        ms(packs) / count as f64,
        fixture.pulled_docs.len(),
        ms(pulled_time),
        ms(pulled_time) / pulled_updates.max(1) as f64,
    );
}
