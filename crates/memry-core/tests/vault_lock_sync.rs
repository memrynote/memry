//! A lock written before Step 16 reaches the server on the next pass (Step 16,
//! #3533): `sync_now` seeds its `vault_lock` record before it pulls, and the
//! push carries it, under a declaration that subscribes to `vault_lock`. A
//! declaration without it (iOS's twenty-one) never pulls locks, so it seeds
//! none. Real `HttpClient`, `AuthSession`, SQLite and sealing; only the
//! transport and the secure store are fakes.

#![cfg(feature = "markdown")]

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::types::{
    DESKTOP_ONLY_RECORD_ITEM_TYPES, Declaration, SUBSCRIBED_ITEM_TYPES,
};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

use crate::http_fakes::{FakeSecureStore, FakeTransport, jwt, response};

const DEVICE: &str = "server-device-1";
const LOCK: &str = "folder:Projects";

/// A vault holding one lock row a 14e build wrote, a session over a fake
/// transport that answers the devices fetch, one empty pull page and a push,
/// and a connection of its own to the vault's `data.db`.
struct Fixture {
    vault: Vault,
    data: Connection,
    transport: Arc<FakeTransport>,
    session: Arc<AuthSession>,
    // Last, so the database closes before its directory goes.
    _dir: TempDir,
}

fn fixture() -> Fixture {
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
    let dir = tempfile::Builder::new()
        .prefix("memry-vault-lock-sync-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.path().display().to_string()).expect("open");
    let data = Connection::open(dir.path().join("data.db")).expect("a connection of its own");
    data.execute(
        "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
         VALUES (?1, 'folder', 'Projects', 1, 5, 6)",
        [LOCK],
    )
    .expect("a lock row a 14e build wrote");

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
            &json!({"accepted": [LOCK], "rejected": [], "serverTime": 1, "maxCursor": 1})
                .to_string(),
        ),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            "https://sync.example.com".to_string(),
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
    Fixture {
        vault,
        data,
        transport,
        session,
        _dir: dir,
    }
}

fn row_clock(data: &Connection) -> Option<String> {
    data.query_row(
        "SELECT clock FROM vault_locks WHERE id = ?1",
        [LOCK],
        |row| row.get(0),
    )
    .expect("the row")
}

#[tokio::test]
async fn a_pass_pushes_a_lock_written_before_step_16() {
    let fixture = fixture();
    let types: Vec<&str> = SUBSCRIBED_ITEM_TYPES
        .iter()
        .chain(DESKTOP_ONLY_RECORD_ITEM_TYPES.iter())
        .copied()
        .collect();
    let desktop = Declaration::declare(&types).expect("the desktop set");

    let summary = fixture
        .vault
        .sync_with_declaration(fixture.session.clone(), desktop)
        .sync_now()
        .await
        .expect("the pass");

    assert_eq!((summary.pushed, summary.pending), (1, 0), "{summary:?}");
    let pushes = fixture.transport.calls_to("/sync/push");
    let body = String::from_utf8(pushes[0].body.clone().expect("a body")).expect("utf-8");
    assert!(body.contains(LOCK) && body.contains("vault_lock"), "{body}");
    assert!(
        row_clock(&fixture.data).is_some(),
        "the row is clocked by its record"
    );
}

/// A declaration that never pulls `vault_lock` would push a lock whose peers'
/// edits it never sees, ticking only its own clock.
#[tokio::test]
async fn a_declaration_without_vault_lock_seeds_no_lock() {
    let fixture = fixture();

    let summary = fixture
        .vault
        .sync(fixture.session.clone())
        .sync_now()
        .await
        .expect("the pass");

    assert_eq!((summary.pushed, summary.pending), (0, 0), "{summary:?}");
    assert!(fixture.transport.calls_to("/sync/push").is_empty());
    assert_eq!(row_clock(&fixture.data), None, "the row stays unseeded");
    let records: i64 = fixture
        .data
        .query_row(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'vault_lock'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(records, 0);
}
