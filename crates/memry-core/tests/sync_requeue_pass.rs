//! `VaultSync::sync_now` (the iOS pass) re-queues a concurrent merge and
//! pushes it in the same pass, at the union clock (chapter 06 §6.5.2 P3).
//!
//! Real `HttpClient`, `AuthSession`, SQLite and chapter 04 crypto; only the
//! transport and the secure store are fakes.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::account::{AccountSealer, DeviceSigner};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::SyncOperation;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::repositories::sync_items::{InboundRecord, SyncItemRow};
use memry_core::sync::apply::apply_inbound_on;
use memry_core::sync::push::{PendingRecord, PushSealer as _};
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const DEVICE: &str = "device-a";
const TASK: &str = "task-1";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];

fn task(title: &str, clock: Json) -> String {
    json!({"title": title, "projectId": "proj-1", "priority": 2, "clock": clock}).to_string()
}

/// The peer's row, sealed and signed as the server would serve it.
fn sealed_task(secret_key: Vec<u8>, clock: Json) -> Json {
    let signer = DeviceSigner::new(DEVICE, secret_key).expect("a signer");
    let vault_key = derive_vault_key(MASTER_KEY.to_vec()).expect("the vault key");
    AccountSealer::new(vault_key, signer)
        .seal_record(&PendingRecord {
            operation: SyncOperation::Update,
            row: SyncItemRow {
                item_type: "task".to_owned(),
                item_id: TASK.to_owned(),
                payload: Some(task("From the peer", clock.clone())),
                payload_state: "full".to_owned(),
                clock: Some(clock.to_string()),
                field_clocks: None,
                server_cursor: None,
                signer_device_id: None,
                updated_at: 1,
                deleted_at: None,
                corrupt_reason: None,
                corrupt_at: None,
            },
        })
        .expect("seals")
}

#[tokio::test]
async fn a_pass_that_merges_a_concurrent_record_pushes_it_once_at_the_union_clock() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": DEVICE, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-requeue-pass-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");
    // This device's row, already pushed: nothing is queued for it.
    vault
        .db_handle()
        .call_blocking(|conn| {
            let local = InboundRecord {
                item_type: "task".to_owned(),
                item_id: TASK.to_owned(),
                payload_json: task("Local", json!({"local": 2})),
                server_cursor: Some(1),
                signer_device_id: Some(DEVICE.to_owned()),
                updated_at: 1,
                deleted_at: None,
            };
            apply_inbound_on(conn, &local, 1, None).map(drop)
        })
        .expect("seed the local row");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({
                "items": [{"id": TASK, "type": "task", "version": 2,
                           "modifiedAt": 1_760_000_000_000_i64, "size": 12}],
                "deleted": [], "hasMore": false, "nextCursor": 2,
            })
            .to_string(),
        ),
        response(
            200,
            &json!({"items": [sealed_task(secret.to_vec(), json!({"local": 1, "peer": 1}))]})
                .to_string(),
        ),
        response(
            200,
            &json!({"accepted": [TASK], "rejected": [], "serverTime": 1, "maxCursor": 2})
                .to_string(),
        ),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_owned(),
            "ios".to_owned(),
            DeviceDescriptor {
                name: "Phone".to_owned(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_owned(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(
        summary.pushed, 1,
        "the merge re-queued the task: {summary:?}"
    );
    assert_eq!(summary.pending, 0, "{summary:?}");
    let pushes = transport.calls_to("/sync/push");
    assert_eq!(pushes.len(), 1);
    let pushed = body_json(&pushes[0]);
    assert_eq!(pushed["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(pushed["items"][0]["id"], json!(TASK));
    assert_eq!(
        pushed["items"][0]["clock"],
        json!({"local": 2, "peer": 1}),
        "the union, not ticked again"
    );
}
