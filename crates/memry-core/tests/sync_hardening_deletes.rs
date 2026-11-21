//! A pulled delete verifies before it deletes (chapter 05 §5.14, #5334).
//!
//! The server is untrusted, so a delete it could forge (a bad signature, a
//! signer the directory does not name, a key that is not the signer's, or a
//! real signature over another item) is one corrupt item: the note stays
//! alive and the page's other items still apply. A real delete, as Electron
//! seals it (`record-envelope.json`, which `push_seal` holds the core's
//! sealer to byte for byte) and as this core seals it, still deletes.
//!
//! Real `HttpClient`, SQLite, pull, `AccountCipher` and envelope crypto; the
//! transport is the only fake.

use std::sync::Arc;

use memry_core::crypto::{keys, sodium};
use memry_core::protocol::account::{AccountCipher, device_directory};
use memry_core::protocol::envelope::{self, RecordMaterial, RecordRequest, SyncOperation};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use memry_core::sync::pull::{PullLoop, PullReport};
use serde_json::{Value as Json, json};

use crate::http_fakes::{FakeTransport, response};
use crate::support::{hex_field, str_field, vector_file};
use crate::sync_hardening_repairs::{pull_live, scratch_db};

const DELETED_AT: i64 = 1_760_000_000_000;
const PEER_SEED: u8 = 31;
const STRANGER_SEED: u8 = 32;

fn keypair(seed: u8) -> (Vec<u8>, Vec<u8>) {
    let (public, secret) = sodium::sign_seed_keypair(&[seed; 32]).expect("a keypair");
    (public.to_vec(), secret.to_vec())
}

fn vault_key() -> Vec<u8> {
    keys::derive_vault_key(&[7; 32])
        .expect("the vault key")
        .to_vec()
}

fn http(transport: Arc<FakeTransport>) -> HttpClient {
    HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
    )
}

/// The cipher a device whose directory names only `signer` opens with.
async fn cipher(vault_key: Vec<u8>, signer: &str, public_key: &[u8]) -> AccountCipher {
    let body = json!({
        "devices": [{ "id": signer, "signingPublicKey": keys::base64_encode(public_key) }]
    });
    let http = http(FakeTransport::new(vec![response(200, &body.to_string())]));
    let directory = device_directory(&http).await.expect("a directory");
    AccountCipher::new(vault_key, directory)
}

/// `id` sealed and signed as `signer` with `seed`'s key, a delete when
/// `content` is `None`.
fn sealed(id: &str, signer: &str, seed: u8, content: Option<&Json>) -> Json {
    let vault_key = vault_key();
    let bytes = content.map(Json::to_string).unwrap_or_default();
    let sealed = envelope::encrypt(
        &RecordRequest {
            id,
            item_type: "note",
            operation: if content.is_some() {
                SyncOperation::Update
            } else {
                SyncOperation::Delete
            },
            content: bytes.as_bytes(),
            vault_key: &vault_key,
            signing_secret_key: &keypair(seed).1,
            signer_device_id: signer,
            clock: Some([("peer".to_owned(), 5)].into()),
            state_vector: None,
            deleted_at: content.is_none().then_some(DELETED_AT),
        },
        &RecordMaterial::random(),
    )
    .expect("sealed");
    envelope::to_json(&sealed.envelope)
}

/// One feed page through the hardened pull, opened with `cipher`.
async fn pull(db: &Db, cipher: AccountCipher, items: Vec<Json>) -> PullReport {
    let listed: Vec<Json> = items
        .iter()
        .map(|item| json!({ "id": item["id"], "type": "note" }))
        .collect();
    let changes = json!({ "items": listed, "deleted": [], "hasMore": false, "nextCursor": "20" });
    let transport = FakeTransport::new(vec![
        response(200, &changes.to_string()),
        response(200, &json!({ "items": items }).to_string()),
    ]);
    let declaration = Declaration::declare(&["note"]).expect("recognised");
    PullLoop::new(
        Arc::new(http(transport)),
        db.clone(),
        declaration,
        Arc::new(cipher),
    )
    .with_hardening()
    .pull_page()
    .await
    .expect("the page")
}

fn alive(db: &Db, id: &str) -> bool {
    let id = id.to_owned();
    db.call_blocking(move |conn| sync_items::load(conn, "note", &id))
        .expect("read the row")
        .is_some_and(|row| row.deleted_at.is_none())
}

fn stub(id: &str) -> Json {
    json!({
        "id": id, "type": "note", "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "peer",
    })
}

/// Pulls `forged` for the live note `n1` beside a real update of `n2`: the
/// forged delete is one corrupt item and deletes nothing.
async fn assert_refused(forged: Json) {
    let db = scratch_db();
    pull_live(&db, vec![stub("n1")]).await;
    let peer = keypair(PEER_SEED).0;
    let update = sealed("n2", "peer", PEER_SEED, Some(&json!({ "title": "Kept" })));

    let report = pull(
        &db,
        cipher(vault_key(), "peer", &peer).await,
        vec![forged, update],
    )
    .await;

    assert_eq!((report.corrupt, report.deleted), (1, 0), "{report:?}");
    assert_eq!(report.applied, 1, "the page's other item still applies");
    assert!(!report.refused);
    assert!(alive(&db, "n1"), "a forged delete deletes nothing");
    assert!(alive(&db, "n2"));
}

#[tokio::test]
async fn sync_hardening_a_delete_with_a_bad_signature_deletes_nothing() {
    let mut forged = sealed("n1", "peer", PEER_SEED, None);
    forged["signature"] = json!(keys::base64_encode(&[0; 64]));
    assert_refused(forged).await;
}

#[tokio::test]
async fn sync_hardening_a_delete_from_a_signer_the_directory_does_not_name_deletes_nothing() {
    assert_refused(sealed("n1", "stranger", STRANGER_SEED, None)).await;
}

#[tokio::test]
async fn sync_hardening_a_delete_signed_with_another_devices_key_deletes_nothing() {
    assert_refused(sealed("n1", "peer", STRANGER_SEED, None)).await;
}

#[tokio::test]
async fn sync_hardening_a_real_signature_over_another_item_deletes_nothing() {
    let mut forged = sealed("other", "peer", PEER_SEED, None);
    forged["id"] = json!("n1");
    assert_refused(forged).await;
}

#[tokio::test]
async fn sync_hardening_a_delete_this_core_signed_deletes() {
    let db = scratch_db();
    pull_live(&db, vec![stub("n1")]).await;
    let peer = keypair(PEER_SEED).0;

    let report = pull(
        &db,
        cipher(vault_key(), "peer", &peer).await,
        vec![sealed("n1", "peer", PEER_SEED, None)],
    )
    .await;

    assert_eq!((report.deleted, report.corrupt), (1, 0), "{report:?}");
    assert!(!alive(&db, "n1"));
}

/// Electron's own delete, sealed by its production code path.
#[tokio::test]
async fn sync_hardening_a_delete_electron_signed_deletes() {
    let file = vector_file("record-envelope");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| str_field(case, "name") == "note delete with deletedAt")
        .expect("the delete case");
    let input = &case["input"];
    let item = case["expected"]["pushItem"].clone();
    let id = str_field(&item, "id").to_owned();
    let signer = str_field(&item, "signerDeviceId").to_owned();
    let (public, _) = sodium::sign_seed_keypair(&hex_field(input, "signingSeedHex")).expect("keys");
    let db = scratch_db();
    pull_live(&db, vec![stub(&id)]).await;

    let cipher = cipher(hex_field(input, "vaultKeyHex"), &signer, &public).await;
    let report = pull(&db, cipher, vec![item]).await;

    assert_eq!((report.deleted, report.corrupt), (1, 0), "{report:?}");
    assert!(!alive(&db, &id));
}
