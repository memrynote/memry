//! `VaultSync::sync_now` (spec 004 TP028a): pull first, then push.
//!
//! Real `HttpClient`, `AuthSession`, SQLite and sealing; only the two foreign
//! seams are fakes. The point of the export is that a phone write leaves the
//! outbox, so the test starts from a local write and ends with an empty outbox
//! and a `/sync/push` that the pull preceded.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-pass-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

#[tokio::test]
async fn a_local_write_is_pulled_over_then_pushed_and_leaves_the_outbox() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = keys::local_device_id_hex(&public).expect("a device id");

    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::AccessToken, "access-1");
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let writer = vault.notes_writer(store.clone()).expect("a writer");
    let note_id = writer
        .create("Written on the phone".to_string(), None)
        .expect("create");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"devices": [{"id": device_id, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        ),
        response(
            200,
            &json!({"accepted": [note_id], "rejected": [], "serverTime": 1, "maxCursor": 1})
                .to_string(),
        ),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.pushed, 1, "{summary:?}");
    assert_eq!(summary.pending, 0, "the outbox drained: {summary:?}");

    let paths: Vec<String> = transport.calls().iter().map(|c| c.url.clone()).collect();
    let pull_at = paths
        .iter()
        .position(|p| p.contains("/sync/changes"))
        .expect("a pull");
    let push_at = paths
        .iter()
        .position(|p| p.contains("/sync/push"))
        .expect("a push");
    assert!(pull_at < push_at, "pull before push: {paths:?}");

    let pushed = body_json(&transport.calls_to("/sync/push")[0]);
    assert_eq!(pushed["items"][0]["id"], json!(note_id));
    assert_eq!(pushed["items"][0]["type"], json!("note"));
}
