//! The production sealer, against the committed vectors and a fake transport.
//!
//! `PushCoordinator` was tested behind a fake sealer, which pinned *which
//! bytes the wave chose* and said nothing about what left the device. This
//! file closes the other half: [`AccountSealer`] is the only `PushSealer`
//! production has, and everything below drives that one.
//!
//! Rule 2 of `packages/contracts/test-vectors/README.md` governs the first two
//! tests: the committed JSON is the input and the only input. Nothing here
//! regenerates a vector or recomputes an expectation.
//!
//! | Test                                         | Rule                                    |
//! | -------------------------------------------- | --------------------------------------- |
//! | every record vector, byte for byte           | chapter 04 §4.2 – §4.8, SC-001          |
//! | the one state-vector case is **not** signed  | chapter 04 §4.6, §4.10                  |
//! | every CRDT vector, byte for byte             | chapter 04 §4.11, §4.12                 |
//! | seal, then open with the read path           | chapter 04 §4.12, chapter 01 §1.4.0     |
//! | the pushed bytes are the live row's          | chapter 06 §6.5.2 P2                    |
//! | `_offline` never reaches the wire            | chapter 06 §6.6                         |
//! | a clock-required row with no clock is refused | chapter 05 §5.4                        |
//! | a policy refusal leaves the queue untouched  | chapter 11 §11.9                        |

mod http_fakes;
mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, body_json, error_response, response};
use memry_core::api::errors::StorageError;
use memry_core::crypto::sodium;
use memry_core::protocol::account::{AccountCipher, AccountSealer, DeviceSigner, SealEntropy};
use memry_core::protocol::crdt_envelope::CrdtMaterial;
use memry_core::protocol::envelope::{self, RecordMaterial, SyncOperation};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items::SyncItemRow;
use memry_core::storage::{Db, open_data};
use memry_core::sync::body_pull::{CrdtCipher, PackedUpdate};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::pull::RecordCipher;
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use rusqlite::params;
use serde_json::{Value as Json, json};
use support::{hex_field, str_field, vector_file};
use zeroize::Zeroizing;

// ---------------------------------------------------------------- fixtures

/// The committed file key and the two committed nonces.
///
/// A vector cannot contain a random value and also be reproducible, which is
/// why [`SealEntropy`] exists at all: production draws
/// [`RandomEntropy`] and this draws the file's own bytes.
struct FixedEntropy {
    file_key: Vec<u8>,
    data_nonce: Vec<u8>,
    key_nonce: Vec<u8>,
}

impl FixedEntropy {
    fn of(input: &Json) -> Arc<Self> {
        Arc::new(Self {
            file_key: hex_field(input, "fileKeyHex"),
            data_nonce: hex_field(input, "dataNonceHex"),
            key_nonce: hex_field(input, "keyNonceHex"),
        })
    }
}

impl SealEntropy for FixedEntropy {
    fn record(&self) -> RecordMaterial {
        RecordMaterial {
            file_key: Zeroizing::new(self.file_key.clone()),
            data_nonce: self.data_nonce.clone(),
            key_nonce: self.key_nonce.clone(),
        }
    }

    fn crdt(&self) -> CrdtMaterial {
        CrdtMaterial {
            file_key: Zeroizing::new(self.file_key.clone()),
            data_nonce: self.data_nonce.clone(),
            key_nonce: self.key_nonce.clone(),
        }
    }
}

/// The signer a vector case implies: its seed, and the device id its expected
/// `signerDeviceId` names.
fn vector_signer(input: &Json, device_id: &str) -> (Vec<u8>, DeviceSigner) {
    let (public, secret) = sodium::sign_seed_keypair(&hex_field(input, "signingSeedHex"))
        .expect("the vector's seed is a keypair");
    (
        public,
        DeviceSigner::new(device_id, secret.to_vec()).expect("a signer"),
    )
}

/// A `sync_items` row carrying exactly what a vector case describes.
fn row_of(input: &Json) -> SyncItemRow {
    SyncItemRow {
        item_type: str_field(input, "type").to_owned(),
        item_id: str_field(input, "id").to_owned(),
        payload: Some(str_field(input, "contentUtf8").to_owned()),
        payload_state: "full".to_owned(),
        clock: match &input["clock"] {
            Json::Null => None,
            clock => Some(clock.to_string()),
        },
        field_clocks: None,
        server_cursor: None,
        signer_device_id: None,
        updated_at: 1,
        deleted_at: input["deletedAt"].as_i64(),
        corrupt_reason: None,
        corrupt_at: None,
    }
}

fn pending(input: &Json) -> PendingRecord {
    PendingRecord {
        operation: SyncOperation::from_wire(Some(str_field(input, "operation")))
            .expect("a known operation"),
        row: row_of(input),
    }
}

// ------------------------------------------------- SC-001, the record class

/// Every `record-envelope.json` case whose input carries no `stateVector`,
/// sealed through the production path, byte for byte.
#[test]
fn the_sealer_reproduces_the_record_vectors_byte_for_byte() {
    let file = vector_file("record-envelope");
    let mut checked = 0;

    for case in file["cases"].as_array().expect("cases") {
        let name = str_field(case, "name");
        let input = &case["input"];
        let expected = &case["expected"]["pushItem"];
        if input["stateVector"].is_string() {
            // Handled by its own test below: the record push omits the field,
            // so this writer must not sign it and cannot match a vector that
            // did.
            continue;
        }

        let (_public, signer) = vector_signer(input, str_field(expected, "signerDeviceId"));
        let sealer = AccountSealer::with_entropy(
            hex_field(input, "vaultKeyHex"),
            signer,
            FixedEntropy::of(input),
        );

        let sealed = sealer
            .seal_record(&pending(input))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(&sealed, expected, "{name}");
        checked += 1;
    }

    assert_eq!(checked, 8, "eight of the nine cases carry no state vector");
}

/// Chapter 04 §4.6 and §4.10: the record push omits `stateVector`, and the
/// server reconstructs the signature payload from what it received.
///
/// So a writer that signed a state vector it did not send would be refused
/// `403 SYNC_INVALID_SIGNATURE` on every item. The vector's one state-vector
/// case pins the **general** writer; this sealer is the record-push one, and
/// the difference is asserted rather than quietly skipped.
#[test]
fn the_record_push_neither_sends_nor_signs_a_state_vector() {
    let file = vector_file("record-envelope");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["input"]["stateVector"].is_string())
        .expect("the one state-vector case");
    let input = &case["input"];
    let expected = &case["expected"]["pushItem"];

    let (_public, signer) = vector_signer(input, str_field(expected, "signerDeviceId"));
    let sealer = AccountSealer::with_entropy(
        hex_field(input, "vaultKeyHex"),
        signer,
        FixedEntropy::of(input),
    );
    let sealed = sealer.seal_record(&pending(input)).expect("seals");

    assert!(expected.get("stateVector").is_some(), "the vector has one");
    assert!(
        sealed.get("stateVector").is_none(),
        "§4.6: a conforming client MUST NOT send it"
    );
    // The ciphertext is identical — same key, same nonces, same plaintext —
    // and only the signature differs, which is the whole of the difference.
    for field in ["encryptedKey", "keyNonce", "encryptedData", "dataNonce"] {
        assert_eq!(sealed[field], expected[field], "{field}");
    }
    assert_ne!(
        sealed["signature"], expected["signature"],
        "signing a field the server will not see is a 403 on every item"
    );
}

// --------------------------------------------------- SC-001, the CRDT class

#[test]
fn the_sealer_reproduces_the_crdt_vectors_byte_for_byte() {
    let file = vector_file("crdt-update");
    let mut checked = 0;

    for case in file["cases"].as_array().expect("cases") {
        let name = str_field(case, "name");
        let input = &case["input"];
        let expected = &case["expected"];

        let (_public, signer) = vector_signer(input, "device-a");
        let sealer = AccountSealer::with_entropy(
            hex_field(input, "vaultKeyHex"),
            signer,
            FixedEntropy::of(input),
        );

        let packed = sealer
            .seal_crdt_update(str_field(input, "noteId"), &hex_field(input, "updateHex"))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            hex::encode(&packed),
            str_field(expected, "packedHex"),
            "{name}"
        );
        assert_eq!(
            packed.len() as u64,
            expected["packedBytes"].as_u64().expect("packedBytes"),
            "{name}"
        );
        checked += 1;
    }

    assert_eq!(
        checked,
        file["cases"].as_array().expect("cases").len(),
        "every case ran"
    );
}

// ------------------------------------------------------------- round trips

/// The directory `GET /auth/devices` would answer for one device.
///
/// Built through the real reader rather than by hand, because
/// `DeviceDirectory` has no other constructor and inventing one for a test
/// would be a second way to build the thing the read path depends on.
async fn directory_of(
    device_id: &str,
    public_key: &[u8],
) -> memry_core::protocol::account::DeviceDirectory {
    use base64::Engine as _;
    let body = json!({
        "devices": [{
            "id": device_id,
            "signingPublicKey": base64::engine::general_purpose::STANDARD.encode(public_key),
        }]
    })
    .to_string();
    let http = HttpClient::new(
        FakeTransport::new(vec![response(200, &body)]),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    memry_core::protocol::account::device_directory(&http)
        .await
        .expect("a directory")
}

/// Seal, then open with the path a peer uses, and compare the plaintext.
#[tokio::test]
async fn a_sealed_record_opens_again_through_the_read_path() {
    let file = vector_file("record-envelope");
    let input = &file["cases"][0]["input"];
    let vault_key = hex_field(input, "vaultKeyHex");
    let (public, signer) = vector_signer(input, "device-a");

    let sealer = AccountSealer::new(vault_key.clone(), signer);
    let item = pending(input);
    let sealed = sealer.seal_record(&item).expect("seals");

    let cipher = AccountCipher::new(vault_key, directory_of("device-a", &public).await);
    let opened = RecordCipher::open(&cipher, &envelope::from_json(&sealed).expect("a wire item"))
        .expect("opens");
    assert_eq!(
        opened,
        item.row.payload.as_deref().expect("a payload").as_bytes(),
        "the recovered payload is the stored one, byte for byte"
    );

    // Random material, so a second seal of the same row is a different
    // ciphertext and still opens: §4.3's nonce is per operation, never a
    // counter.
    let again = sealer.seal_record(&item).expect("seals again");
    assert_ne!(again["encryptedData"], sealed["encryptedData"]);
    assert_ne!(again["dataNonce"], sealed["dataNonce"]);
}

#[tokio::test]
async fn a_sealed_crdt_update_opens_again_through_the_read_path() {
    let file = vector_file("crdt-update");
    let input = &file["cases"][0]["input"];
    let vault_key = hex_field(input, "vaultKeyHex");
    let (public, signer) = vector_signer(input, "device-a");
    let update = hex_field(input, "updateHex");

    let sealer = AccountSealer::new(vault_key.clone(), signer);
    let packed = sealer
        .seal_crdt_update(str_field(input, "noteId"), &update)
        .expect("packs");

    let cipher = AccountCipher::new(vault_key, directory_of("device-a", &public).await);
    let opened = CrdtCipher::open(
        &cipher,
        &PackedUpdate {
            doc_id: str_field(input, "noteId"),
            signer_device_id: Some("device-a"),
            packed: &packed,
        },
    )
    .expect("opens");
    assert_eq!(opened, update);
}

// --------------------------------------- §6.5.2 P2 and §6.6, over the wave

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-push-seal-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed_item(db: &Db, item_type: &str, item_id: &str, payload: &str, clock: Option<&str>) {
    let (item_type, item_id) = (item_type.to_owned(), item_id.to_owned());
    let (payload, clock) = (payload.to_owned(), clock.map(str::to_owned));
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
             VALUES (?1, ?2, ?3, 'full', ?4, 1)
             ON CONFLICT(item_type, item_id) DO UPDATE SET
                 payload = excluded.payload, clock = excluded.clock",
            params![item_type, item_id, payload, clock],
        )
        .map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })?;
        Ok(())
    })
    .expect("seed the live row");
}

fn enqueue(db: &Db, item_type: &str, item_id: &str) {
    let change = Change::upsert(item_type, item_id);
    db.call_blocking(move |conn| outbox::commit(conn, &change, 1, |_| Ok(())).map(|_| ()))
        .expect("enqueue");
}

fn coordinator(
    db: Db,
    transport: Arc<FakeTransport>,
    sealer: Arc<dyn PushSealer>,
) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(Arc::new(http), db, Declaration::subscribed(), sealer)
        .with_vault("vault-1")
}

fn push_ok(accepted: &[&str]) -> String {
    json!({"accepted": accepted, "rejected": [], "serverTime": 1, "maxCursor": 1}).to_string()
}

fn outbox_count_and_attempts(db: &Db) -> (i64, i64) {
    db.call_blocking(|conn| {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(attempt_count), 0) FROM outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })
    })
    .expect("read the outbox")
}

/// §6.5.2 P2, end to end: the **ciphertext that left the device** decrypts to
/// the row as it stood at send time, not as it stood at enqueue.
///
/// The existing coordinator test asserts this against a recording fake, which
/// can only show which plaintext the wave chose. This one opens what was
/// actually sent.
#[tokio::test]
async fn the_bytes_on_the_wire_are_the_live_row_read_at_send_time() {
    let db = scratch_db("live-row");
    seed_item(
        &db,
        "task",
        "t1",
        r#"{"title":"at enqueue"}"#,
        Some(r#"{"device-a":1}"#),
    );
    enqueue(&db, "task", "t1");
    // The edit that lands between the enqueue and the send.
    seed_item(
        &db,
        "task",
        "t1",
        r#"{"title":"after the enqueue"}"#,
        Some(r#"{"device-a":2}"#),
    );

    let (public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
    let signer = DeviceSigner::new("device-a", secret.to_vec()).expect("a signer");
    let vault_key = vec![3u8; 32];
    let sealer = Arc::new(AccountSealer::new(vault_key.clone(), signer));

    let transport = FakeTransport::new(vec![response(200, &push_ok(&["t1"]))]);
    let report = coordinator(db.clone(), transport.clone(), sealer)
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(report.accepted, 1);

    let sent = body_json(&transport.calls_to("/sync/push")[0]);
    let item = envelope::from_json(&sent["items"][0]).expect("a wire item");
    // Chapter 01 §1.7: the routing fact travels in the header, nowhere in the
    // envelope, so the header is the only place it can be checked.
    assert_eq!(
        transport.calls_to("/sync/push")[0]
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("X-Memry-Vault-Id"))
            .map(|(_, value)| value.as_str()),
        Some("vault-1")
    );

    let cipher = AccountCipher::new(vault_key, directory_of("device-a", &public).await);
    let opened = RecordCipher::open(&cipher, &item).expect("opens");
    assert_eq!(
        String::from_utf8(opened).expect("utf-8"),
        r#"{"title":"after the enqueue"}"#,
        "a frozen payload reintroduces §6.5.1 case 3c deterministically"
    );
    // The clock travels with it, and it is the live row's clock too.
    assert_eq!(sent["items"][0]["clock"], json!({"device-a": 2}));
}

/// §6.6: a clock containing `_offline` MUST never reach the server.
#[tokio::test]
async fn the_reserved_offline_key_never_reaches_the_wire() {
    let db = scratch_db("offline");
    seed_item(
        &db,
        "task",
        "t1",
        r#"{"title":"x"}"#,
        Some(r#"{"_offline":2,"device-a":1}"#),
    );
    enqueue(&db, "task", "t1");

    let (_public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
    let sealer = Arc::new(AccountSealer::new(
        vec![3u8; 32],
        DeviceSigner::new("device-a", secret.to_vec()).expect("a signer"),
    ));
    let transport = FakeTransport::new(vec![response(200, &push_ok(&["t1"]))]);
    coordinator(db.clone(), transport.clone(), sealer)
        .drain_wave()
        .await
        .expect("the wave");

    let sent = body_json(&transport.calls_to("/sync/push")[0]);
    // Rebound onto this device, ticks **added**, and the reserved key gone.
    assert_eq!(sent["items"][0]["clock"], json!({"device-a": 3}));
    assert!(
        !sent.to_string().contains("_offline"),
        "the reserved key reached the wire: {sent}"
    );
}

/// §5.4: every record type but `settings` must carry a clock. A row that
/// cannot supply one is refused at the seal rather than sent for the server to
/// reject for ever.
#[tokio::test]
async fn a_clock_required_row_with_no_clock_is_refused_and_never_sent() {
    let db = scratch_db("no-clock");
    seed_item(&db, "task", "t1", r#"{"title":"x"}"#, None);
    enqueue(&db, "task", "t1");

    let (_public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
    let sealer = Arc::new(AccountSealer::new(
        vec![3u8; 32],
        DeviceSigner::new("device-a", secret.to_vec()).expect("a signer"),
    ));
    // No request is made, so the script is deliberately empty: an unscripted
    // call panics.
    let transport = FakeTransport::new(vec![]);
    let report = coordinator(db.clone(), transport.clone(), sealer)
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(report.retired, 1);
    assert_eq!(report.accepted, 0);
    assert_eq!(transport.call_count(), 0);

    // And `settings`, the one exempt type, goes out clockless.
    let db = scratch_db("settings");
    seed_item(&db, "settings", "s1", r#"{"theme":"dark"}"#, None);
    enqueue(&db, "settings", "s1");
    let (_public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
    let sealer = Arc::new(AccountSealer::new(
        vec![3u8; 32],
        DeviceSigner::new("device-a", secret.to_vec()).expect("a signer"),
    ));
    let transport = FakeTransport::new(vec![response(200, &push_ok(&["s1"]))]);
    let report = coordinator(db.clone(), transport.clone(), sealer)
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(report.accepted, 1);
    let sent = body_json(&transport.calls_to("/sync/push")[0]);
    assert!(sent["items"][0].get("clock").is_none(), "{sent}");
}

/// §11.9, with the real sealer: the kill switch leaves the queue exactly as it
/// found it.
#[tokio::test]
async fn a_kill_switch_refusal_leaves_the_row_queued_with_its_attempt_count_unmoved() {
    let db = scratch_db("kill-switch");
    seed_item(
        &db,
        "task",
        "t1",
        r#"{"title":"x"}"#,
        Some(r#"{"device-a":1}"#),
    );
    enqueue(&db, "task", "t1");
    assert_eq!(outbox_count_and_attempts(&db), (1, 0));

    let (_public, secret) = sodium::sign_seed_keypair(&[9u8; 32]).expect("a keypair");
    let sealer = Arc::new(AccountSealer::new(
        vec![3u8; 32],
        DeviceSigner::new("device-a", secret.to_vec()).expect("a signer"),
    ));
    let transport = FakeTransport::new(vec![error_response(
        403,
        "PLATFORM_WRITES_DISABLED",
        "writes are off for ios",
    )]);
    let error = coordinator(db.clone(), transport, sealer)
        .drain_wave()
        .await
        .expect_err("the wave is refused");
    assert!(error.to_string().contains("writes are off"), "{error}");

    // No row removed, and no backoff accrued against a condition the user
    // cannot fix.
    assert_eq!(outbox_count_and_attempts(&db), (1, 0));
}
