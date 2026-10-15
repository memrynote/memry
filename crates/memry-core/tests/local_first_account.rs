//! A device used without an account, then signed in: the device identity it
//! writes under, attaching its vault to the account, and the billing routes.
//!
//! | Test                                                 | Rule                                   |
//! | ---------------------------------------------------- | -------------------------------------- |
//! | the identity is minted once and then reused          | one key per device (data-model §B)     |
//! | a locked keychain mints nothing                      | locked is not absent                   |
//! | an offline write is queued and seeding adds nothing  | outbox commits with the write (FR-030) |
//! | sign-in commits the key minted offline               | chapter 02 §2.5, offline clocks' owner |
//! | a registered vault name opens with the vault key     | desktop `vault-name-crypto.ts`         |
//! | 402 is PaymentRequired, 409 is success               | `routes/sync.ts:107-131`               |
//! | no master key makes no request                       | nothing to seal the name with          |
//! | the billing routes post their documented bodies      | `routes/auth.ts:812-867`               |

mod http_fakes;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::*;
use memry_core::api::auth::{AuthSession, DeviceDescriptor, ensure_device_identity};
use memry_core::api::crypto::decrypt_vault_name;
use memry_core::api::errors::{ApiError, AuthError, SecureStoreError, StorageError};
use memry_core::api::vault::Vault;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::open_data;
use rusqlite::Connection;
use serde_json::json;

const MASTER_KEY: [u8; 32] = [11u8; 32];
static SCRATCH: AtomicU64 = AtomicU64::new(0);

type Script = Vec<Result<HttpResponse, memry_core::api::errors::TransportError>>;

fn session(transport: Arc<FakeTransport>, store: Arc<FakeSecureStore>) -> AuthSession {
    let device = DeviceDescriptor {
        name: "iPhone".to_string(),
        platform: DevicePlatform::Ios,
        os_version: None,
        app_version: "1.0.0".to_string(),
        vault_id: None,
    };
    AuthSession::new(
        transport,
        store,
        "https://sync.example.com".to_string(),
        "ios".to_string(),
        device,
    )
    .unwrap()
}

fn sign_in_script() -> Script {
    let setup = jwt(json!({ "sub": "u", "jti": "jti-1", "exp": 4_102_444_800u64 }));
    vec![
        response(200, r#"{"success":true,"expiresIn":600}"#),
        response(
            200,
            &format!(r#"{{"success":true,"setupToken":"{setup}"}}"#),
        ),
        response(
            200,
            r#"{"success":true,"deviceId":"d","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
    ]
}

async fn sign_in(session: &AuthSession) {
    session
        .request_email_code("k@example.com".into())
        .await
        .unwrap();
    session.verify_email_code("123456".into()).await.unwrap();
    session.register_device().await.unwrap();
}

/// Signed in, unlocked with the master key, then `extra` answered in order.
async fn signed_in(extra: Script) -> (AuthSession, Arc<FakeTransport>) {
    let mut script = sign_in_script();
    script.extend(extra);
    let transport = FakeTransport::new(script);
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .unwrap();
    let session = session(transport.clone(), store);
    sign_in(&session).await;
    (session, transport)
}

fn last_call(transport: &FakeTransport) -> memry_core::seams::transport::HttpRequest {
    transport.calls().pop().expect("a request")
}

#[test]
fn the_identity_is_minted_once_and_then_reused() {
    let store = FakeSecureStore::new();
    ensure_device_identity(store.clone()).unwrap();
    let first = store
        .get(SecureStoreKey::DeviceSigningKey)
        .unwrap()
        .unwrap();
    assert_eq!(first.len(), 64);
    ensure_device_identity(store.clone()).unwrap();
    assert_eq!(
        store.get(SecureStoreKey::DeviceSigningKey).unwrap(),
        Some(first)
    );
}

#[test]
fn a_locked_keychain_mints_nothing() {
    let store = FakeSecureStore::new();
    store.lock_device();
    assert!(matches!(
        ensure_device_identity(store.clone()),
        Err(AuthError::SecureStore {
            source: SecureStoreError::Locked
        })
    ));
    store.unlock_device();
    assert_eq!(store.get(SecureStoreKey::DeviceSigningKey).unwrap(), None);
}

#[test]
fn an_offline_write_is_queued_and_seeding_adds_nothing() {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("memry-local-first-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let vault = Vault::open("vault-local".into(), dir.display().to_string()).unwrap();

    // A device that never signed in has no identity, so a writer is refused
    // until the shell ensures one.
    let store = FakeSecureStore::new();
    assert!(vault.notes_writer(store.clone()).is_err());
    ensure_device_identity(store.clone()).unwrap();
    let writer = vault.notes_writer(store).unwrap();
    writer.create("Offline".into(), None).unwrap();
    writer.create("Also offline".into(), None).unwrap();

    let count = |sql: &str| -> i64 {
        open_data(&dir.join("data.db"))
            .unwrap()
            .call_blocking(move |conn: &mut Connection| {
                conn.query_row(sql, [], |row| row.get(0))
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string(),
                    })
            })
            .unwrap()
    };
    // Every locally written record already has its outbox row: the state
    // desktop's seed exists to reach.
    let unqueued = "SELECT COUNT(*) FROM sync_items s WHERE s.payload_state = 'full'
                    AND NOT EXISTS (SELECT 1 FROM outbox o
                      WHERE o.item_type = s.item_type AND o.item_id = s.item_id)";
    assert_eq!(count(unqueued), 0);
    let queued = count("SELECT COUNT(*) FROM outbox");
    assert!(queued >= 2, "{queued}");

    assert_eq!(vault.seed_unsynced().unwrap(), 0);
    assert_eq!(count("SELECT COUNT(*) FROM outbox"), queued);
}

#[tokio::test]
async fn sign_in_commits_the_key_minted_offline() {
    let store = FakeSecureStore::new();
    ensure_device_identity(store.clone()).unwrap();
    let offline = store
        .get(SecureStoreKey::DeviceSigningKey)
        .unwrap()
        .unwrap();
    let public = BASE64.encode(&offline[32..64]);

    let transport = FakeTransport::new(sign_in_script());
    sign_in(&session(transport.clone(), store.clone())).await;

    let calls = transport.calls();
    assert_eq!(body_json(&calls[1])["devicePublicKey"], public);
    assert_eq!(body_json(&calls[2])["authPublicKey"], public);
    assert_eq!(
        store.get(SecureStoreKey::DeviceSigningKey).unwrap(),
        Some(offline)
    );
}

#[tokio::test]
async fn a_registered_vault_name_opens_with_the_vault_key() {
    let (session, transport) = signed_in(vec![response(200, r#"{"success":true}"#)]).await;
    let id = "0f8e3a52-9c1d-4b7e-a2f0-5d6c7b8a9e01";
    session
        .register_vault(id.into(), "Phone".into())
        .await
        .unwrap();

    let call = last_call(&transport);
    assert_eq!(call.method, "POST");
    assert!(call.url.ends_with("/sync/vaults"), "{}", call.url);
    let body = body_json(&call);
    assert_eq!(body["vaultUuid"], id);
    let opened = decrypt_vault_name(
        MASTER_KEY.to_vec(),
        id.into(),
        body["encryptedName"].as_str().unwrap().into(),
        body["nameNonce"].as_str().unwrap().into(),
    );
    assert_eq!(opened.as_deref(), Some("Phone"));
}

#[tokio::test]
async fn payment_required_is_typed_and_a_conflict_is_success() {
    let (session, _t) = signed_in(vec![
        response(402, r#"{"error":"Active sync subscription required"}"#),
        error_response(402, "SYNC_VAULT_LIMIT_EXCEEDED", "full"),
        error_response(409, "CONFLICT", "exists"),
    ])
    .await;
    match session.register_vault("v1".into(), "A".into()).await {
        Err(ApiError::PaymentRequired { code: None, .. }) => {}
        other => panic!("expected PaymentRequired, got {other:?}"),
    }
    match session.register_vault("v1".into(), "A".into()).await {
        Err(ApiError::PaymentRequired {
            code: Some(code), ..
        }) => {
            assert_eq!(code, "SYNC_VAULT_LIMIT_EXCEEDED")
        }
        other => panic!("expected PaymentRequired, got {other:?}"),
    }
    session
        .register_vault("v1".into(), "A".into())
        .await
        .unwrap();
}

#[tokio::test]
async fn no_master_key_makes_no_request() {
    let transport = FakeTransport::new(sign_in_script());
    let session = session(transport.clone(), FakeSecureStore::new());
    sign_in(&session).await;
    assert_eq!(
        session.register_vault("v1".into(), "A".into()).await,
        Err(ApiError::NoMasterKey)
    );
    assert_eq!(transport.call_count(), 3);
    // An id that would change a route is refused before sealing anything.
    let (unlocked, _t) = signed_in(vec![]).await;
    assert!(matches!(
        unlocked.register_vault("../x".into(), "A".into()).await,
        Err(ApiError::InvalidClientIdentity { .. })
    ));
}

const BILLING: &str = r#"{"plan":"plus","status":"active","limits":{"storageLimit":1},
    "usage":{"storageUsed":0},"expiresAt":1,"store":"app_store","willRenew":true,
    "appAccountToken":"0f8e3a52-9c1d-4b7e-a2f0-5d6c7b8a9e01","canManageBilling":false}"#;

#[tokio::test]
async fn the_billing_routes_post_their_documented_bodies() {
    let (session, transport) = signed_in(vec![
        response(200, BILLING),
        response(200, BILLING),
        response(200, r#"{"checkoutToken":"p.s","expiresAt":1700000000}"#),
        response(200, r#"{"portalUrl":"https://portal.example.com/x"}"#),
        error_response(409, "VALIDATION_ERROR", "no customer"),
    ])
    .await;

    let status = session
        .submit_app_store_transaction("jws.value.sig".into())
        .await
        .unwrap();
    assert_eq!(status.store.as_deref(), Some("app_store"));
    assert_eq!(status.will_renew, Some(true));
    let call = last_call(&transport);
    assert!(call.url.ends_with("/auth/billing/app-store/transactions"));
    assert_eq!(
        body_json(&call),
        json!({ "signedTransactionInfo": "jws.value.sig" })
    );

    assert_eq!(session.refresh_billing().await.unwrap().plan, "plus");
    assert!(
        last_call(&transport)
            .url
            .ends_with("/auth/billing/reconcile")
    );

    let token = session.checkout_token().await.unwrap();
    assert_eq!(
        (token.token.as_str(), token.expires_at),
        ("p.s", 1_700_000_000)
    );
    assert!(last_call(&transport).url.ends_with("/auth/checkout-token"));

    assert_eq!(
        session.billing_portal_url().await.unwrap(),
        "https://portal.example.com/x"
    );
    assert!(matches!(
        session.billing_portal_url().await,
        Err(ApiError::BillingPortalUnavailable { .. })
    ));
    assert!(
        last_call(&transport)
            .url
            .ends_with("/auth/billing/portal-session")
    );
    assert_eq!(last_call(&transport).method, "POST");
}
