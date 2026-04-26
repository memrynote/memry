//! Tests for `auth::vault_keys` setup, password unlock, and the boot-time
//! "remember device" path through the keychain.
//!
//! These tests run real Argon2id at the canonical 64 MiB / 3-ops parameters,
//! so each derivation takes ~0.5-1.5s. The suite is intentionally compact.
//! The keychain backend is the in-memory variant; production wires up the
//! macOS Keychain in `lib.rs::init_app_state`.

use std::sync::Arc;

use memry_desktop_tauri_lib::app_state::AppState;
use memry_desktop_tauri_lib::auth::linking::PendingLinkingRegistry;
use memry_desktop_tauri_lib::auth::{AuthRuntime, AuthStateKind};
use memry_desktop_tauri_lib::auth::vault_keys::{
    setup_local_vault_key, try_unlock_from_keychain, unlock_with_password,
};
use memry_desktop_tauri_lib::db::{settings, Db};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::keychain::{KeychainStore, MemoryKeychain, SERVICE_VAULT};
use memry_desktop_tauri_lib::vault::VaultRuntime;

const KEYCHAIN_MASTER_KEY: &str = "master-key";

fn fresh_state() -> AppState {
    let db = Db::open_memory().expect("memory db must open");
    let vault = Arc::new(VaultRuntime::boot().expect("vault runtime must boot"));
    let keychain: Arc<dyn KeychainStore> = Arc::new(MemoryKeychain::new());
    let auth = Arc::new(AuthRuntime::new(keychain));
    let linking = Arc::new(PendingLinkingRegistry::new());
    AppState::new(db, vault, auth, linking)
}

#[tokio::test]
async fn setup_persists_kdf_salt_key_verifier_and_remember_device_setting() {
    let state = fresh_state();

    setup_local_vault_key(&state, "correct horse battery staple".into(), true)
        .await
        .unwrap();

    let salt = settings::get(&state.db, "auth.kdfSalt").unwrap();
    let verifier = settings::get(&state.db, "auth.keyVerifier").unwrap();
    let remember = settings::get(&state.db, "auth.rememberDevice").unwrap();

    assert!(salt.is_some(), "auth.kdfSalt must be persisted");
    assert!(verifier.is_some(), "auth.keyVerifier must be persisted");
    assert_eq!(
        remember.as_deref(),
        Some("true"),
        "auth.rememberDevice must be persisted as a bool"
    );
}

#[tokio::test]
async fn setup_with_remember_device_writes_master_key_to_keychain() {
    let state = fresh_state();

    setup_local_vault_key(&state, "secret-pass".into(), true)
        .await
        .unwrap();

    let stored = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        stored.is_some(),
        "remember-device=true must persist master key in keychain",
    );
    assert_eq!(
        stored.as_ref().map(|k| k.len()),
        Some(32),
        "master key must be 32 bytes",
    );
    assert_eq!(state.auth.status().state, AuthStateKind::Unlocked);
    assert!(state.auth.status().remember_device);
}

#[tokio::test]
async fn setup_without_remember_device_keeps_keychain_master_key_absent() {
    let state = fresh_state();

    setup_local_vault_key(&state, "secret-pass".into(), false)
        .await
        .unwrap();

    let stored = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        stored.is_none(),
        "remember-device=false must not write master key to keychain",
    );
    assert_eq!(state.auth.status().state, AuthStateKind::Unlocked);
    assert!(!state.auth.status().remember_device);
}

#[tokio::test]
async fn unlock_with_correct_password_returns_unlocked_status() {
    let state = fresh_state();
    setup_local_vault_key(&state, "right-password".into(), false)
        .await
        .unwrap();
    state.auth.lock().unwrap();

    let status = unlock_with_password(&state, "right-password".into(), true)
        .await
        .unwrap();

    assert_eq!(status.state, AuthStateKind::Unlocked);
    assert!(status.remember_device);
    let master = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        master.is_some(),
        "successful unlock with remember-device must write keychain",
    );
}

#[tokio::test]
async fn unlock_with_wrong_password_returns_invalid_password_and_does_not_touch_keychain() {
    let state = fresh_state();
    setup_local_vault_key(&state, "right-password".into(), false)
        .await
        .unwrap();
    state.auth.lock().unwrap();

    let before = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        before.is_none(),
        "precondition: keychain must be clear because remember-device was false",
    );

    let err = unlock_with_password(&state, "wrong-password".into(), true)
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::InvalidPassword),
        "wrong password must surface AppError::InvalidPassword, got {err:?}",
    );

    let after = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        after.is_none(),
        "wrong password must not write keychain master key",
    );
    assert_eq!(state.auth.status().state, AuthStateKind::Error);
}

#[tokio::test]
async fn unlock_with_correct_password_and_remember_device_false_clears_keychain() {
    let state = fresh_state();
    setup_local_vault_key(&state, "secret".into(), true)
        .await
        .unwrap();
    let stored = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(stored.is_some(), "precondition: keychain has master key");
    state.auth.lock().unwrap();

    let status = unlock_with_password(&state, "secret".into(), false)
        .await
        .unwrap();

    assert_eq!(status.state, AuthStateKind::Unlocked);
    assert!(!status.remember_device);
    let after = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY)
        .unwrap();
    assert!(
        after.is_none(),
        "toggling remember-device off must remove the keychain master key",
    );
}

#[tokio::test]
async fn try_unlock_from_keychain_returns_unlocked_when_remember_device_true() {
    let state = fresh_state();
    setup_local_vault_key(&state, "secret".into(), true)
        .await
        .unwrap();
    state.auth.lock().unwrap();
    assert_eq!(state.auth.status().state, AuthStateKind::Locked);

    let result = try_unlock_from_keychain(&state).unwrap();

    let status = result.expect("remember-device=true with master key must unlock at boot");
    assert_eq!(status.state, AuthStateKind::Unlocked);
    assert!(status.remember_device);
}

#[tokio::test]
async fn try_unlock_from_keychain_returns_none_when_remember_device_false() {
    let state = fresh_state();
    setup_local_vault_key(&state, "secret".into(), false)
        .await
        .unwrap();
    state.auth.lock().unwrap();

    let result = try_unlock_from_keychain(&state).unwrap();

    assert!(
        result.is_none(),
        "remember-device=false must leave the app locked at boot",
    );
    assert_eq!(state.auth.status().state, AuthStateKind::Locked);
}
