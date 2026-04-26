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
use memry_desktop_tauri_lib::auth::vault_keys::setup_local_vault_key;
use memry_desktop_tauri_lib::auth::{AuthRuntime, AuthStateKind};
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
    AppState::new(db, vault, auth)
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
