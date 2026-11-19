//! Local apply benchmark for a fresh-device bootstrap (#5231).
//!
//! Seeds a vault of `MEMRY_BENCH_NOTES` notes (default 10,000) as real sealed
//! envelopes and packed CRDT updates, then times the two local halves of a
//! bootstrap with no network in the way:
//!
//! - **records**: [`PullLoop::run`] over scripted `/sync/changes` and
//!   `/sync/pull` responses, with real Ed25519 verify, AEAD and inflate.
//! - **bodies**: one packed update per note, opened and stored with its
//!   `crdt:<docId>` cursor the way the per-note body pull stores it.
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

use http_fakes::{FakeTransport, response};
use memry_core::crdt::update_log;
use memry_core::crypto::sodium;
use memry_core::protocol::crdt_envelope::{self, CrdtMaterial, CrdtRequest};
use memry_core::protocol::envelope::{
    self, EnvelopeError, RecordEnvelope, RecordMaterial, RecordRequest, SyncOperation,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::nested_tx;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::crdt_cursor_scope;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store;
use serde_json::{Value as Json, json};
use yrs::{ReadTxn as _, StateVector, Text as _, Transact as _};

const SIGNER: &str = "bench-device";
const PAGE: usize = 500;
const PULL_IDS: usize = 100;

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

fn notes() -> usize {
    std::env::var("MEMRY_BENCH_NOTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000)
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
    script: Vec<String>,
    bodies: Vec<(String, Vec<u8>)>,
    signer_public: Vec<u8>,
    vault_key: Vec<u8>,
}

fn seed(count: usize) -> Fixture {
    let vault_key = sodium::random_bytes(32);
    let (public_key, secret_key) = sodium::sign_keypair().expect("a keypair");
    let mut envelopes: Vec<Json> = Vec::with_capacity(count);
    let mut bodies = Vec::with_capacity(count);
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
        let packed = crdt_envelope::pack(
            &CrdtRequest {
                note_id: &id,
                update: &body_update(index),
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("pack a body");
        bodies.push((id, packed));
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
        script,
        bodies,
        signer_public: public_key,
        vault_key,
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
    let report = pull.run(u32::MAX).await.expect("the pull");
    let records = started.elapsed();
    assert_eq!(report.applied, count, "every record applied");
    assert_eq!(report.corrupt, 0);

    let started = Instant::now();
    for (doc_id, packed) in &fixture.bodies {
        let update =
            crdt_envelope::unpack(packed, doc_id, &fixture.vault_key, &fixture.signer_public)
                .expect("open a body");
        let doc = doc_id.clone();
        db.call(move |conn| {
            let txn = nested_tx::begin(conn).expect("begin");
            update_log::append_server_update(&txn, &doc, 1, &update, 0).expect("append");
            store::write_cursor(&txn, &crdt_cursor_scope(&doc), Some("1"), 0)?;
            txn.commit().expect("commit");
            Ok(())
        })
        .await
        .expect("store a body");
    }
    let bodies = started.elapsed();

    let stored: i64 = db
        .call(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
                .expect("count"))
        })
        .await
        .expect("count notes");
    assert_eq!(stored as usize, count);

    let per = |total: std::time::Duration| total.as_secs_f64() * 1000.0 / count as f64;
    println!(
        "apply-bench notes={count} record_crypto_ms={:.0} records_ms={:.0} ms_per_record={:.4} bodies_ms={:.0} ms_per_body={:.4}",
        crypto.as_secs_f64() * 1000.0,
        records.as_secs_f64() * 1000.0,
        per(records),
        bodies.as_secs_f64() * 1000.0,
        per(bodies),
    );
}
