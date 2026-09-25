//! `VaultSync::sync_now` (spec 004 TP028a): pull first, then push.
//!
//! Real `HttpClient`, `AuthSession`, SQLite and sealing; only the two foreign
//! seams are fakes. The point of the export is that a phone write leaves the
//! outbox, so the test starts from a local write and ends with an empty outbox
//! and a `/sync/push` that the pull preceded, signed as the device the server
//! registered (the access token's `device_id`), never the local clock id.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::sync::body_debt;
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
    let local_id = keys::local_device_id_hex(&public).expect("a local device id");
    // The server names devices itself; the local id is only a clock id.
    let device_id = "server-device-1";
    assert_ne!(local_id, device_id);

    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
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
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
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

    // The pass body-pulls notes written at or after its start; a local write
    // in the same millisecond would join them and reorder the script.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
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
    assert_eq!(
        pushed["items"][0]["signerDeviceId"],
        json!(device_id),
        "signed as the registered device: {}",
        pushed["items"][0]
    );
}

/// An attachment manifest is signed as the registered device too: other
/// devices resolve the signer through the account's device list, which never
/// holds the local clock id.
#[tokio::test]
async fn an_attachment_manifest_is_signed_as_the_registered_device() {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let note_id = vault
        .notes_writer(store.clone())
        .expect("a writer")
        .create("Has a picture".to_string(), None)
        .expect("create");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"sessionId": "upload-1", "expiresAt": 9_999_999_999_000i64}).to_string(),
        ),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
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

    vault
        .sync(session)
        .upload_attachment(
            note_id,
            "a.png".to_string(),
            "image/png".to_string(),
            vec![1, 2, 3],
        )
        .await
        .expect("the upload");

    let manifest = transport
        .calls()
        .into_iter()
        .find(|call| call.url.ends_with("/manifest"))
        .expect("a manifest upload");
    assert_eq!(body_json(&manifest)["signerDeviceId"], json!(device_id));
}

/// Two passes started together over one vault run one after the other: the
/// outbox row goes out once, and the second pass finds nothing to push.
#[tokio::test]
async fn overlapping_passes_over_one_vault_push_a_row_once() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let note_id = vault
        .notes_writer(store.clone())
        .expect("a writer")
        .create("Written once".to_string(), None)
        .expect("create");
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    let devices = || {
        response(
            200,
            &json!({"devices": [{"id": device_id, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        )
    };
    let empty_page = || {
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        )
    };
    // Held in flight, so the second pass is started while the first runs.
    let transport = FakeTransport::slow(
        vec![
            devices(),
            empty_page(),
            response(
                200,
                &json!({"accepted": [note_id], "rejected": [], "serverTime": 1, "maxCursor": 1})
                    .to_string(),
            ),
            devices(),
            empty_page(),
        ],
        20,
    );
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

    let first = vault.sync(Arc::clone(&session));
    let second = vault.sync(session);
    let (a, b) = tokio::join!(first.sync_now(), second.sync_now());
    let (a, b) = (a.expect("first pass"), b.expect("second pass"));

    assert_eq!(
        transport.calls_to("/sync/push").len(),
        1,
        "{:?}",
        transport
            .calls()
            .iter()
            .map(|c| c.url.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(a.pushed + b.pushed, 1);
    assert_eq!(a.rejected + b.rejected, 0);
    assert_eq!(b.pending, 0);
}

/// #2294: the body step pulls every document owed a whole-body pull, settles
/// the ones whose pull merged, and keeps the debt of one that stopped at a gap.
#[tokio::test]
async fn the_pass_pulls_owed_bodies_and_settles_only_the_merged_ones() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-pass-owed-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    side.call_blocking(|conn| {
        body_debt::owe(conn, "goodnote1234")?;
        body_debt::owe(conn, "stopnote1234")
    })
    .expect("owe two bodies");

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
        // goodnote1234: no snapshot, no updates. A clean pull.
        response(200, &json!({"snapshot": null}).to_string()),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
        // stopnote1234: an update this device cannot open, so a stop at the gap.
        response(200, &json!({"snapshot": null}).to_string()),
        response(
            200,
            &json!({"updates": [{"sequenceNum": 1, "data": "AAAA", "signerDeviceId": device_id}], "hasMore": false})
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

    assert_eq!(summary.bodies, 2, "{summary:?}");
    let owed = side
        .call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents");
    assert_eq!(owed, ["stopnote1234"], "only the merged pull settles");
}
