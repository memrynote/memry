//! `Vault::sync_with_declaration` (Step 16, #3533): a `VaultSync` sends the
//! declaration it was built with on every request of a pass, and
//! `Vault::sync` keeps sending the twenty-one iOS declares (chapter 13 §13.1).
//!
//! Real `HttpClient`, `AuthSession`, SQLite and sealing; only the transport and
//! the secure store are fakes.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::types::{Declaration, SUBSCRIBED_ITEM_TYPES};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const DEVICE: &str = "server-device-1";

/// One local note write, then a pass: a pull page, a push of the note, and
/// the body step's empty updates page.
async fn pass_headers(declaration: Option<Declaration>) -> (Vec<String>, Vec<String>) {
    let (public, secret) = sodium::sign_seed_keypair(&[11u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": DEVICE, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, [7u8; 32].to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-api-sync-declaration-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let note_id = vault
        .notes_writer(store.clone())
        .expect("a writer")
        .create("Declared".to_string(), None)
        .expect("create");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
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
            "desktop".to_string(),
            DeviceDescriptor {
                name: "Desk".to_string(),
                platform: DevicePlatform::Macos,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );
    // The pass body-pulls notes written at or after its start; a write in the
    // same millisecond would join them and reorder the script.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let sync = match declaration {
        Some(declaration) => vault.sync_with_declaration(session, declaration),
        None => vault.sync(session),
    };
    let summary = sync.sync_now().await.expect("the pass");
    assert_eq!(summary.pushed, 1, "{summary:?}");

    let declared = |path: &str| -> Vec<String> {
        transport
            .calls()
            .iter()
            .filter(|call| call.url.contains(path))
            .map(|call| call.headers["x-memry-sync-types"].clone())
            .collect()
    };
    (declared("/sync/changes"), declared("/sync/push"))
}

#[tokio::test]
async fn a_pass_sends_the_declaration_its_sync_was_built_with() {
    let declaration =
        Declaration::declare(&["note", "vault_lock", "sticky_draft"]).expect("recognised");
    let (pulls, pushes) = pass_headers(Some(declaration)).await;

    assert_eq!(pulls, ["note,vault_lock,sticky_draft,note_body"]);
    assert_eq!(pushes, ["note,vault_lock,sticky_draft"]);
}

#[tokio::test]
async fn vault_sync_still_declares_the_twenty_one() {
    let (pulls, pushes) = pass_headers(None).await;

    let subscribed = SUBSCRIBED_ITEM_TYPES.join(",");
    assert_eq!(pulls, [format!("{subscribed},note_body")]);
    assert_eq!(pushes, [subscribed]);
}
