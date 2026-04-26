//! Tests for the auth flow internals exposed in `auth::account` (Task 13).
//!
//! These tests drive the public `*_with_base` flow functions against
//! `httpmock` and an in-memory keychain/db. Phase D deliberately does
//! not expose Tauri commands; Phase E owns the IPC surface, but the
//! file is named `commands_auth_test` because Phase E will extend it
//! with command-level coverage on top of the same flows.

use std::sync::Arc;

use httpmock::prelude::*;
use serde_json::json;

use memry_desktop_tauri_lib::app_state::AppState;
use memry_desktop_tauri_lib::auth::account::{
    self, AccountInfo, KEYCHAIN_ACCESS_TOKEN, KEYCHAIN_REFRESH_TOKEN, KEYCHAIN_SETUP_TOKEN,
};
use memry_desktop_tauri_lib::auth::linking::PendingLinkingRegistry;
use memry_desktop_tauri_lib::auth::vault_keys::setup_local_vault_key;
use memry_desktop_tauri_lib::auth::{AuthRuntime, AuthStateKind};
use memry_desktop_tauri_lib::commands::{account as account_cmd, auth as auth_cmd, crypto as crypto_cmd, secrets as secrets_cmd};
use memry_desktop_tauri_lib::db::Db;
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::keychain::{
    KeychainStore, MemoryKeychain, SERVICE_VAULT,
};
use memry_desktop_tauri_lib::vault::VaultRuntime;

const KEYCHAIN_RECOVERY_PHRASE: &str = "recovery-phrase";

fn fresh_state() -> AppState {
    let db = Db::open_memory().expect("memory db must open");
    let vault = Arc::new(VaultRuntime::boot().expect("vault runtime must boot"));
    let keychain: Arc<dyn KeychainStore> = Arc::new(MemoryKeychain::new());
    let auth = Arc::new(AuthRuntime::new(keychain));
    let linking = Arc::new(PendingLinkingRegistry::new());
    AppState::new(db, vault, auth, linking)
}

// ---------------------------------------------------------------------
// OTP request / verify
// ---------------------------------------------------------------------

#[tokio::test]
async fn request_otp_returns_success_and_expiry() {
    let state = fresh_state();
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/otp/request")
                .json_body(json!({ "email": "kaan@example.com" }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({ "success": true, "expiresAt": 1_700_000_600 }));
        })
        .await;

    let result = account::request_otp_with_base(&server.base_url(), &state, "kaan@example.com")
        .await
        .expect("request_otp must succeed");

    mock.assert_async().await;
    assert!(result.success);
    assert_eq!(result.expires_at, Some(1_700_000_600));
}

#[tokio::test]
async fn verify_otp_stores_setup_token_and_returns_needs_setup() {
    let state = fresh_state();
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/verify").json_body(json!({
                "email": "kaan@example.com",
                "code": "123456",
            }));
            then.status(200).json_body(json!({
                "needsSetup": true,
                "setupToken": "setup-token-abc",
            }));
        })
        .await;

    let result = account::verify_otp_with_base(
        &server.base_url(),
        &state,
        "kaan@example.com",
        "123456",
    )
    .await
    .expect("verify_otp must succeed");

    mock.assert_async().await;
    assert!(result.needs_setup);
    let stored = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)
        .unwrap();
    assert_eq!(
        stored.as_deref(),
        Some(b"setup-token-abc".as_ref()),
        "verify_otp must persist setup token in keychain",
    );
}

#[tokio::test]
async fn verify_otp_with_existing_user_clears_setup_token_and_stores_session() {
    let state = fresh_state();
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/verify");
            then.status(200).json_body(json!({
                "needsSetup": false,
                "userId": "user-123",
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
            }));
        })
        .await;

    let result = account::verify_otp_with_base(
        &server.base_url(),
        &state,
        "kaan@example.com",
        "123456",
    )
    .await
    .expect("verify_otp must succeed");

    assert!(!result.needs_setup, "existing user must not need setup");

    let kc = state.auth.keychain();
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().as_deref(),
        Some(b"access-1".as_ref()),
    );
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN).unwrap().as_deref(),
        Some(b"refresh-1".as_ref()),
    );
    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN).unwrap().is_none(),
        "an existing-user verify must not leave a stale setup token",
    );
}

// ---------------------------------------------------------------------
// Setup new account
// ---------------------------------------------------------------------

#[tokio::test]
async fn setup_new_account_registers_device_and_returns_recovery_phrase() {
    let state = fresh_state();
    state
        .auth
        .keychain()
        .set_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN, b"setup-token-abc")
        .unwrap();

    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/devices")
                .header("authorization", "Bearer setup-token-abc");
            then.status(200).json_body(json!({
                "userId": "user-9",
                "deviceId": "device-from-server",
                "accessToken": "access-token-xyz",
                "refreshToken": "refresh-token-xyz",
            }));
        })
        .await;

    let input = account::SetupAccountInput {
        password: "correct horse battery staple".into(),
        remember_device: true,
        email: "kaan@example.com".into(),
        device_name: "Test Mac".into(),
        platform: "macos".into(),
        os_version: Some("14.5".into()),
        app_version: "2.0.0".into(),
    };

    let result = account::setup_new_account_with_base(&server.base_url(), &state, input)
        .await
        .expect("setup must succeed");

    mock.assert_async().await;
    assert!(!result.recovery_phrase.is_empty(), "recovery phrase must be returned");
    assert_eq!(result.device_id.len(), 32, "device id is 16-byte hex");

    let kc = state.auth.keychain();
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().as_deref(),
        Some(b"access-token-xyz".as_ref()),
        "access token must be persisted after device registration",
    );
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN).unwrap().as_deref(),
        Some(b"refresh-token-xyz".as_ref()),
    );
    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN).unwrap().is_none(),
        "setup token must be cleared once device registration succeeds",
    );

    let recovery = kc
        .get_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE)
        .unwrap()
        .expect("recovery phrase must persist in keychain");
    assert_eq!(
        String::from_utf8(recovery).unwrap(),
        result.recovery_phrase,
        "stored recovery phrase must match the returned value",
    );

    let info = account::get_account_info(&state)
        .unwrap()
        .expect("account info must be persisted");
    assert_eq!(info.user_id, "user-9");
    assert_eq!(info.email, "kaan@example.com");
    assert_eq!(info.auth_provider, "otp");

    assert_eq!(state.auth.status().state, AuthStateKind::Unlocked);
    assert_eq!(state.auth.status().email.as_deref(), Some("kaan@example.com"));

    let conn = state.db.conn().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_devices WHERE is_current_device = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "current device row must exist");
}

#[tokio::test]
async fn setup_new_account_without_setup_token_returns_auth_error() {
    let state = fresh_state();
    let server = MockServer::start_async().await;

    let input = account::SetupAccountInput {
        password: "p".into(),
        remember_device: false,
        email: "kaan@example.com".into(),
        device_name: "Test".into(),
        platform: "macos".into(),
        os_version: None,
        app_version: "2.0.0".into(),
    };

    let err = account::setup_new_account_with_base(&server.base_url(), &state, input)
        .await
        .expect_err("setup without setup-token must error");

    assert!(matches!(err, AppError::Auth(_)), "expected Auth error, got {err:?}");
}

// ---------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------

#[tokio::test]
async fn refresh_session_rotates_access_and_refresh_tokens() {
    let state = fresh_state();
    let kc = state.auth.keychain();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, b"old-refresh").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, b"old-access").unwrap();

    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/refresh")
                .header("authorization", "Bearer old-refresh");
            then.status(200).json_body(json!({
                "accessToken": "new-access",
                "refreshToken": "new-refresh",
            }));
        })
        .await;

    account::refresh_session_with_base(&server.base_url(), &state)
        .await
        .expect("refresh must succeed");

    mock.assert_async().await;
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().as_deref(),
        Some(b"new-access".as_ref()),
    );
    assert_eq!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN).unwrap().as_deref(),
        Some(b"new-refresh".as_ref()),
    );
}

#[tokio::test]
async fn refresh_session_without_refresh_token_returns_auth_error() {
    let state = fresh_state();
    let server = MockServer::start_async().await;

    let err = account::refresh_session_with_base(&server.base_url(), &state)
        .await
        .expect_err("missing refresh token must error");

    assert!(matches!(err, AppError::Auth(_)), "expected Auth error, got {err:?}");
}

// ---------------------------------------------------------------------
// Logout (clears tokens, locks runtime)
// ---------------------------------------------------------------------

#[tokio::test]
async fn logout_clears_tokens_and_locks_runtime() {
    let state = fresh_state();

    setup_local_vault_key(&state, "p".into(), false).await.unwrap();
    let kc = state.auth.keychain();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, b"a").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, b"r").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN, b"s").unwrap();
    let _ = account::set_account_info(
        &state,
        &AccountInfo {
            user_id: "u".into(),
            email: "e@x".into(),
            auth_provider: "otp".into(),
        },
    );
    assert_eq!(state.auth.status().state, AuthStateKind::Unlocked);

    account::logout(&state).unwrap();

    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().is_none());
    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN).unwrap().is_none());
    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN).unwrap().is_none());
    assert_eq!(state.auth.status().state, AuthStateKind::Locked);
}

// ---------------------------------------------------------------------
// Recovery phrase
// ---------------------------------------------------------------------

#[tokio::test]
async fn get_recovery_phrase_returns_phrase_when_unlocked_and_present() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();
    state
        .auth
        .keychain()
        .set_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE, b"phrase-abc")
        .unwrap();

    let phrase = account::get_recovery_phrase(&state).unwrap();

    assert_eq!(phrase, "phrase-abc");
}

#[test]
fn get_recovery_phrase_when_locked_returns_vault_locked() {
    let state = fresh_state();
    state
        .auth
        .keychain()
        .set_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE, b"phrase-abc")
        .unwrap();

    let err = account::get_recovery_phrase(&state).unwrap_err();

    assert!(
        matches!(err, AppError::VaultLocked),
        "locked state must surface VaultLocked, got {err:?}",
    );
}

// ---------------------------------------------------------------------
// Phase E: Command-level surface (auth, account, secrets, crypto)
//
// These tests exercise the inner functions that back each
// `#[tauri::command]`. The Tauri wrapper itself is a 1-2 line
// delegation; testing the inner verifies the IPC-callable surface
// without needing a real Tauri runtime.
// ---------------------------------------------------------------------

#[test]
fn auth_status_command_returns_locked_initial_state() {
    let state = fresh_state();
    let status = auth_cmd::auth_status_inner(&state);
    assert_eq!(status.state, AuthStateKind::Locked);
    assert!(status.device_id.is_none());
    assert!(status.email.is_none());
    assert!(!status.has_biometric);
}

#[tokio::test]
async fn auth_unlock_command_unlocks_with_correct_password() {
    let state = fresh_state();
    setup_local_vault_key(&state, "correct horse".into(), false)
        .await
        .unwrap();
    state.auth.lock().unwrap();
    assert_eq!(state.auth.status().state, AuthStateKind::Locked);

    let status = auth_cmd::auth_unlock_inner(
        &state,
        auth_cmd::AuthUnlockInput {
            password: "correct horse".into(),
            remember_device: false,
        },
    )
    .await
    .expect("unlock must succeed");

    assert_eq!(status.state, AuthStateKind::Unlocked);
}

#[tokio::test]
async fn auth_unlock_command_rejects_wrong_password() {
    let state = fresh_state();
    setup_local_vault_key(&state, "right".into(), false)
        .await
        .unwrap();
    state.auth.lock().unwrap();

    let err = auth_cmd::auth_unlock_inner(
        &state,
        auth_cmd::AuthUnlockInput {
            password: "wrong".into(),
            remember_device: false,
        },
    )
    .await
    .expect_err("wrong password must reject");

    assert!(matches!(err, AppError::InvalidPassword));
}

#[tokio::test]
async fn auth_lock_command_clears_runtime_state() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();
    assert_eq!(state.auth.status().state, AuthStateKind::Unlocked);

    auth_cmd::auth_lock_inner(&state).expect("lock must succeed");

    assert_eq!(state.auth.status().state, AuthStateKind::Locked);
    assert!(state.auth.master_key_clone().is_none());
}

#[tokio::test]
async fn auth_enable_biometric_returns_post_v1_stub() {
    let result = auth_cmd::auth_enable_biometric_inner()
        .await
        .expect("biometric stub must succeed");
    assert!(!result.ok, "biometric stub must report ok=false");
    assert_eq!(result.reason, "not-implemented-post-v1");
}

#[test]
fn secrets_set_provider_key_command_persists_status_view() {
    let state = fresh_state();
    let status = secrets_cmd::secrets_set_provider_key_inner(
        &state,
        secrets_cmd::SecretsSetProviderKeyInput {
            provider: "openai".into(),
            raw_key: "sk-test-1234567890ABCD".into(),
            label: Some("Personal".into()),
        },
    )
    .expect("set must succeed");

    assert!(status.configured);
    assert_eq!(status.provider, "openai");
    assert_eq!(status.label.as_deref(), Some("Personal"));
    assert_eq!(status.last4.as_deref(), Some("ABCD"));
    assert!(status.updated_at.is_some());
}

#[test]
fn secrets_get_provider_key_status_command_returns_unconfigured_when_absent() {
    let state = fresh_state();
    let status = secrets_cmd::secrets_get_provider_key_status_inner(
        &state,
        secrets_cmd::SecretsGetProviderKeyStatusInput {
            provider: "anthropic".into(),
        },
    )
    .expect("get must succeed");

    assert!(!status.configured);
    assert!(status.label.is_none());
    assert!(status.last4.is_none());
    assert!(status.updated_at.is_none());
}

#[test]
fn secrets_delete_provider_key_command_removes_keychain_entries() {
    let state = fresh_state();
    secrets_cmd::secrets_set_provider_key_inner(
        &state,
        secrets_cmd::SecretsSetProviderKeyInput {
            provider: "openrouter".into(),
            raw_key: "or-1234".into(),
            label: None,
        },
    )
    .unwrap();

    secrets_cmd::secrets_delete_provider_key_inner(
        &state,
        secrets_cmd::SecretsDeleteProviderKeyInput {
            provider: "openrouter".into(),
        },
    )
    .expect("delete must succeed");

    let after = secrets_cmd::secrets_get_provider_key_status_inner(
        &state,
        secrets_cmd::SecretsGetProviderKeyStatusInput {
            provider: "openrouter".into(),
        },
    )
    .unwrap();
    assert!(!after.configured);
}

#[test]
fn secrets_set_provider_key_command_validates_provider() {
    let state = fresh_state();
    let err = secrets_cmd::secrets_set_provider_key_inner(
        &state,
        secrets_cmd::SecretsSetProviderKeyInput {
            provider: "rogue".into(),
            raw_key: "x".into(),
            label: None,
        },
    )
    .expect_err("unknown provider must be rejected");

    assert!(matches!(err, AppError::Validation(_)));
}

#[test]
fn account_get_info_command_returns_none_when_absent() {
    let state = fresh_state();
    let info = account_cmd::account_get_info_inner(&state).expect("must succeed");
    assert!(info.is_none(), "no settings → no view");
}

#[test]
fn account_get_info_command_returns_view_after_set() {
    let state = fresh_state();
    account::set_account_info(
        &state,
        &AccountInfo {
            user_id: "u-1".into(),
            email: "kaan@example.com".into(),
            auth_provider: "otp".into(),
        },
    )
    .unwrap();

    let info = account_cmd::account_get_info_inner(&state)
        .expect("must succeed")
        .expect("view must be populated");
    assert_eq!(info.user_id, "u-1");
    assert_eq!(info.email, "kaan@example.com");
    assert_eq!(info.auth_provider, "otp");
}

#[tokio::test]
async fn account_sign_out_command_clears_tokens_and_locks_runtime() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();
    let kc = state.auth.keychain();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, b"a").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, b"r").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN, b"s").unwrap();

    let result = account_cmd::account_sign_out_inner(&state).expect("sign out must succeed");
    assert!(result.success);
    assert!(result.error.is_none());

    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().is_none());
    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN).unwrap().is_none());
    assert!(kc.get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN).unwrap().is_none());
    assert_eq!(state.auth.status().state, AuthStateKind::Locked);
}

#[tokio::test]
async fn account_get_recovery_key_command_returns_phrase_when_unlocked() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();
    state
        .auth
        .keychain()
        .set_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE, b"phrase-xyz")
        .unwrap();

    let phrase = account_cmd::account_get_recovery_key_inner(&state).expect("must succeed");
    assert_eq!(phrase, "phrase-xyz");
}

#[test]
fn account_get_recovery_key_command_when_locked_returns_vault_locked() {
    let state = fresh_state();
    state
        .auth
        .keychain()
        .set_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE, b"phrase-xyz")
        .unwrap();

    let err = account_cmd::account_get_recovery_key_inner(&state).unwrap_err();
    assert!(matches!(err, AppError::VaultLocked));
}

// ---------------------------------------------------------------------
// Phase E: crypto command surface
// ---------------------------------------------------------------------

#[tokio::test]
async fn crypto_encrypt_decrypt_round_trip_uses_session_vault_key() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();

    let encrypted = crypto_cmd::crypto_encrypt_item_inner(
        &state,
        crypto_cmd::CryptoEncryptItemInput {
            plaintext_b64: base64_encode(b"hello memry"),
            associated_data_b64: None,
        },
    )
    .expect("encrypt must succeed");
    assert!(!encrypted.ciphertext_b64.is_empty());
    assert!(!encrypted.nonce_b64.is_empty());

    let decrypted = crypto_cmd::crypto_decrypt_item_inner(
        &state,
        crypto_cmd::CryptoDecryptItemInput {
            ciphertext_b64: encrypted.ciphertext_b64.clone(),
            nonce_b64: encrypted.nonce_b64.clone(),
            associated_data_b64: None,
        },
    )
    .expect("decrypt must succeed");

    assert_eq!(base64_decode(&decrypted.plaintext_b64), b"hello memry");
}

#[test]
fn crypto_encrypt_item_when_locked_returns_vault_locked() {
    let state = fresh_state();
    let err = crypto_cmd::crypto_encrypt_item_inner(
        &state,
        crypto_cmd::CryptoEncryptItemInput {
            plaintext_b64: base64_encode(b"x"),
            associated_data_b64: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::VaultLocked));
}

#[test]
fn crypto_verify_signature_command_validates_ed25519() {
    use memry_desktop_tauri_lib::crypto::sign_verify::{generate_keypair, sign_detached};

    let state = fresh_state();
    let kp = generate_keypair();
    let sig = sign_detached(b"message", &kp.secret_key).unwrap();

    let result = crypto_cmd::crypto_verify_signature_inner(
        &state,
        crypto_cmd::CryptoVerifySignatureInput {
            message_b64: base64_encode(b"message"),
            signature_b64: base64_encode(&sig),
            public_key_b64: base64_encode(&kp.public_key),
        },
    )
    .expect("verify must complete");
    assert!(result.valid);

    // Tampered message must verify=false but not error.
    let bad = crypto_cmd::crypto_verify_signature_inner(
        &state,
        crypto_cmd::CryptoVerifySignatureInput {
            message_b64: base64_encode(b"tampered"),
            signature_b64: base64_encode(&sig),
            public_key_b64: base64_encode(&kp.public_key),
        },
    )
    .expect("verify must complete even when invalid");
    assert!(!bad.valid);
}

#[test]
fn crypto_get_rotation_progress_returns_idle_status() {
    let state = fresh_state();
    let progress = crypto_cmd::crypto_get_rotation_progress_inner(&state)
        .expect("rotation progress must succeed");
    assert!(!progress.in_progress);
    assert_eq!(progress.completed, 0);
    assert_eq!(progress.total, 0);
}

#[tokio::test]
async fn crypto_rotate_keys_returns_unsupported_in_m4() {
    let state = fresh_state();
    setup_local_vault_key(&state, "p".into(), false).await.unwrap();

    let result = crypto_cmd::crypto_rotate_keys_inner(&state)
        .expect("rotate must complete");
    assert!(!result.success);
    assert_eq!(result.reason.as_deref(), Some("not-implemented-in-m4"));
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn base64_decode(input: &str) -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(input).expect("base64 decode")
}
