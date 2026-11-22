//! A pulled delete whose signer is not in the pass's device directory
//! (chapter 01 §1.4.0, #5413).
//!
//! `VaultSync::sync_now` end to end: real `HttpClient`, `AuthSession`, SQLite,
//! sealing and signature checks; the transport is scripted in call order.
//!
//! | Test                                                        | Rule              |
//! | ----------------------------------------------------------- | ----------------- |
//! | the delete applies on the next pass, after the refetch       | §1.4.0, #5413     |
//! | a local edit is held while the delete waits, never pushed    | §5.8, #5413       |
//! | a delete whose signature fails otherwise is never re-pulled  | §5.14, #5340      |
//! | a signer that never appears stops being re-pulled            | #5413             |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::{self, RecordMaterial, RecordRequest, SyncOperation};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use memry_core::sync::outbox::{self, Change};
use rusqlite::params;
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const THIS_DEVICE_SEED: [u8; 32] = [11u8; 32];
/// The device that registered and deleted after this pass fetched the list.
const NEW_DEVICE_SEED: [u8; 32] = [13u8; 32];
const NEW_DEVICE: &str = "server-device-2";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

type Scripted = Result<HttpResponse, TransportError>;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn vault(label: &str, transport: Arc<FakeTransport>) -> (Vault, Db, Arc<AuthSession>) {
    let (_public, secret) = sodium::sign_seed_keypair(&THIS_DEVICE_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": "server-device-1", "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-unknown-signer-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    let session = Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );
    (vault, side, session)
}

/// `GET /auth/devices`: this device, plus the new one once it is listed.
fn devices(with_new: bool) -> Scripted {
    let key = |seed: &[u8; 32]| {
        let (public, _secret) = sodium::sign_seed_keypair(seed).expect("a keypair");
        BASE64.encode(&public)
    };
    let mut listed =
        vec![json!({"id": "server-device-1", "signingPublicKey": key(&THIS_DEVICE_SEED)})];
    if with_new {
        listed.push(json!({"id": NEW_DEVICE, "signingPublicKey": key(&NEW_DEVICE_SEED)}));
    }
    response(200, &json!({ "devices": listed }).to_string())
}

/// `id`'s clockless delete, signed by the new device.
fn delete_by_new_device(item_type: &str, id: &str) -> Json {
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let (_public, secret) = sodium::sign_seed_keypair(&NEW_DEVICE_SEED).expect("a keypair");
    let sealed = envelope::encrypt(
        &RecordRequest {
            id,
            item_type,
            operation: SyncOperation::Delete,
            content: b"",
            vault_key: &vault_key[..],
            signing_secret_key: &secret[..],
            signer_device_id: NEW_DEVICE,
            clock: None,
            state_vector: None,
            deleted_at: Some(1_760_000_000_000),
        },
        &RecordMaterial::random(),
    )
    .expect("sealed");
    let mut json = envelope::to_json(&sealed.envelope);
    json["serverCursor"] = json!(3);
    json
}

/// A feed page that lists `deleted`, then the by-id pull that returns them.
fn deleted_page(deleted: &[&str], items: Vec<Json>) -> [Scripted; 2] {
    [
        response(
            200,
            &json!({"items": [], "deleted": deleted, "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
        response(200, &json!({ "items": items }).to_string()),
    ]
}

fn empty_changes() -> Scripted {
    response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
            .to_string(),
    )
}

fn live_row(side: &Db, item_type: &str, id: &str) {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    side.call_blocking(move |conn| {
        sync_items::upsert_metadata_only(conn, &item_type, &id, 1, Some(1))
    })
    .expect("a live row");
}

fn deleted(side: &Db, item_type: &str, id: &str) -> bool {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    side.call_blocking(move |conn| sync_items::load(conn, &item_type, &id))
        .expect("read")
        .expect("the row")
        .deleted_at
        .is_some()
}

fn urls(transport: &FakeTransport) -> Vec<String> {
    transport
        .calls()
        .iter()
        .map(|call| call.url.trim_start_matches(BASE).to_owned())
        .collect()
}

#[tokio::test]
async fn a_delete_from_a_device_the_list_did_not_hold_yet_applies_on_the_next_pass() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("next-pass", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);

    sync.sync_now().await.expect("the first pass");
    assert!(!deleted(&side, "note", "deadnotexxxx"), "unverified: kept");

    // The next pass fetches the list again, which now holds the new device,
    // and re-pulls the refused delete by id before the feed.
    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(response(
        200,
        &json!({"items": [delete_by_new_device("note", "deadnotexxxx")]}).to_string(),
    ));
    transport.push(empty_changes());
    let summary = sync.sync_now().await.expect("the second pass");

    assert!(deleted(&side, "note", "deadnotexxxx"), "{summary:?}");
    let second = &urls(&transport)[first..];
    assert_eq!(second[1], "/sync/pull", "{second:?}");
    assert!(second[2].starts_with("/sync/changes"), "{second:?}");

    // Settled: a third pass re-pulls nothing.
    transport.push(devices(true));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the third pass");
}

#[tokio::test]
async fn a_settings_edit_is_held_while_its_unverified_delete_waits() {
    let [page, pulled] = deleted_page(
        &["editor"],
        vec![delete_by_new_device("settings", "editor")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("held-edit", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('settings', 'editor', ?1, 'full', 1, 1)",
            params![r#"{"fontSize":14}"#],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("settings", "editor"), 1, |_| Ok(())).map(|_| ())
    })
    .expect("an edited settings row");
    let sync = vault.sync(session);

    // The server takes any settings write over a delete, so sending the edit
    // now would bring the item back on every device. The script answers no
    // `/sync/push`: an attempt panics the transport.
    let summary = sync.sync_now().await.expect("the first pass");
    assert_eq!(summary.pending, 1, "the edit stays queued: {summary:?}");
    assert!(!deleted(&side, "settings", "editor"));

    transport.push(devices(true));
    transport.push(response(
        200,
        &json!({"items": [delete_by_new_device("settings", "editor")]}).to_string(),
    ));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the second pass");

    assert!(deleted(&side, "settings", "editor"));
    assert!(transport.calls_to("/sync/push").is_empty());
}

#[tokio::test]
async fn a_delete_whose_signature_fails_for_another_reason_is_never_re_pulled() {
    let mut forged = delete_by_new_device("note", "deadnotexxxx");
    forged["signature"] = delete_by_new_device("note", "othernotexxx")["signature"].clone();
    let [page, pulled] = deleted_page(&["deadnotexxxx"], vec![forged]);
    // The new device is listed from the start: the signer resolves, and the
    // signature is over another item.
    let transport = FakeTransport::new(vec![devices(true), page, pulled]);
    let (vault, side, session) = vault("forged", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);

    sync.sync_now().await.expect("the first pass");
    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the second pass");

    assert!(!deleted(&side, "note", "deadnotexxxx"));
    let second = &urls(&transport)[first..];
    assert!(second.iter().all(|url| url != "/sync/pull"), "{second:?}");
}

#[tokio::test]
async fn a_signer_that_never_appears_stops_being_re_pulled() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("bounded", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    // Five passes re-pull it; after that the row is left as it is.
    for pass in 0..7 {
        let before = transport.call_count();
        transport.push(devices(false));
        if pass < 5 {
            transport.push(response(
                200,
                &json!({"items": [delete_by_new_device("note", "deadnotexxxx")]}).to_string(),
            ));
        }
        transport.push(empty_changes());
        sync.sync_now().await.expect("a pass");
        let urls = &urls(&transport)[before..];
        assert_eq!(urls[1] == "/sync/pull", pass < 5, "pass {pass}: {urls:?}");
    }

    assert!(
        !deleted(&side, "note", "deadnotexxxx"),
        "never verified: kept"
    );
}
