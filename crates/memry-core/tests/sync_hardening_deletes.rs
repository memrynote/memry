//! A pulled delete verifies before it deletes (chapter 05 §5.14, #5334).
//!
//! The server is untrusted, so a delete it could forge (a bad signature, a
//! signer the directory does not name, a key that is not the signer's, or a
//! real signature over another item) is one corrupt item: the note stays
//! alive and the page's other items still apply. A real delete, as Electron
//! seals it (`record-envelope.json`, which `push_seal` holds the core's
//! sealer to byte for byte) and as this core seals it, still deletes.
//!
//! A real delete arrives with its id in `deleted` and no ref row, so every
//! case runs in that shape too. An id in `deleted` deletes only through a
//! verified typed delete (§5.12.1, #5340): a bare id with no item, or with
//! an item the pull refused, deletes nothing, as in Electron.
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
use memry_core::sync::hardening::quarantine;
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

/// How a changes page lists the pulled items' ids.
#[derive(Clone, Copy, Debug)]
enum Listed {
    /// As ref rows in `items`.
    Refs,
    /// In `deleted` only, as the server lists a tombstone.
    Deleted,
    /// In both.
    Both,
}

const SHAPES: [Listed; 3] = [Listed::Refs, Listed::Deleted, Listed::Both];

/// One feed page through the hardened pull, opened with `cipher`. `listed`
/// says where `targets` go; every other item is a ref row. `bare` ids join
/// `deleted` with no item in the pull.
async fn pull_page(
    db: &Db,
    cipher: AccountCipher,
    items: Vec<Json>,
    targets: &[&str],
    listed: Listed,
    bare: &[&str],
) -> PullReport {
    let target = |item: &&Json| targets.contains(&item["id"].as_str().unwrap_or_default());
    let refs: Vec<Json> = items
        .iter()
        .filter(|item| !matches!(listed, Listed::Deleted) || !target(item))
        .map(|item| json!({ "id": item["id"], "type": "note" }))
        .collect();
    let mut deleted: Vec<&str> = bare.to_vec();
    if !matches!(listed, Listed::Refs) {
        deleted.extend(targets);
    }
    let changes =
        json!({ "items": refs, "deleted": deleted, "hasMore": false, "nextCursor": "20" });
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

async fn pull(db: &Db, cipher: AccountCipher, items: Vec<Json>) -> PullReport {
    pull_page(db, cipher, items, &[], Listed::Refs, &[]).await
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

/// Pulls `forged` for the live note `n1` beside a real update of `n2`, with
/// `n1` listed in each shape: the forged delete is one corrupt item and
/// deletes nothing, also when the server lists `n1` in `deleted`.
async fn assert_refused(forged: Json) {
    for listed in SHAPES {
        let db = scratch_db();
        pull_live(&db, vec![stub("n1")]).await;
        let peer = keypair(PEER_SEED).0;
        let update = sealed("n2", "peer", PEER_SEED, Some(&json!({ "title": "Kept" })));

        let report = pull_page(
            &db,
            cipher(vault_key(), "peer", &peer).await,
            vec![forged.clone(), update],
            &["n1"],
            listed,
            &[],
        )
        .await;

        assert_eq!(
            (report.corrupt, report.deleted),
            (1, 0),
            "{listed:?} {report:?}"
        );
        assert_eq!(
            report.applied, 1,
            "{listed:?}: the page's other item still applies"
        );
        assert!(!report.refused, "{listed:?}");
        assert!(
            alive(&db, "n1"),
            "{listed:?}: a forged delete deletes nothing"
        );
        assert!(alive(&db, "n2"), "{listed:?}");
    }
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
    for listed in SHAPES {
        let db = scratch_db();
        pull_live(&db, vec![stub("n1")]).await;
        let peer = keypair(PEER_SEED).0;

        let report = pull_page(
            &db,
            cipher(vault_key(), "peer", &peer).await,
            vec![sealed("n1", "peer", PEER_SEED, None)],
            &["n1"],
            listed,
            &[],
        )
        .await;

        assert_eq!(
            (report.deleted, report.corrupt),
            (1, 0),
            "{listed:?} {report:?}"
        );
        assert!(!alive(&db, "n1"), "{listed:?}");
    }
}

/// §5.12.1 (#5340): an id in `deleted` that the pull returned no item for
/// carries no signature, so it deletes nothing, as in Electron.
#[tokio::test]
async fn sync_hardening_a_bare_deleted_id_deletes_nothing() {
    let db = scratch_db();
    pull_live(&db, vec![stub("n1")]).await;
    let peer = keypair(PEER_SEED).0;
    let update = sealed("n2", "peer", PEER_SEED, Some(&json!({ "title": "Kept" })));

    let report = pull_page(
        &db,
        cipher(vault_key(), "peer", &peer).await,
        vec![update],
        &[],
        Listed::Refs,
        &["n1"],
    )
    .await;

    assert_eq!(
        (report.applied, report.deleted, report.corrupt),
        (1, 0, 0),
        "{report:?}"
    );
    assert!(alive(&db, "n1"), "a bare id deletes nothing");
    assert!(alive(&db, "n2"));
}

/// A bad signature counts toward the quarantine (§5.14): the third forged
/// delete of `n1` makes its entry permanent.
#[tokio::test]
async fn sync_hardening_a_delete_with_a_bad_signature_is_quarantined() {
    let db = scratch_db();
    pull_live(&db, vec![stub("n1")]).await;
    let peer = keypair(PEER_SEED).0;
    let mut forged = sealed("n1", "peer", PEER_SEED, None);
    forged["signature"] = json!(keys::base64_encode(&[0; 64]));

    for _ in 0..3 {
        let cipher = cipher(vault_key(), "peer", &peer).await;
        pull_page(
            &db,
            cipher,
            vec![forged.clone()],
            &["n1"],
            Listed::Deleted,
            &[],
        )
        .await;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch")
        .as_millis() as i64;
    let entries = db
        .call_blocking(move |conn| quarantine::entries(conn, now_ms))
        .expect("the quarantine");
    let entries: Vec<(&str, &str, bool)> = entries
        .iter()
        .map(|entry| {
            (
                entry.item_type.as_str(),
                entry.item_id.as_str(),
                entry.permanent,
            )
        })
        .collect();
    assert_eq!(entries, [("note", "n1", true)]);
    assert!(alive(&db, "n1"));
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
