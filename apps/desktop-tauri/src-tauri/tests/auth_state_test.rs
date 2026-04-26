//! Tests for `AuthRuntime` state machine transitions.
//!
//! These tests use the in-memory keychain backend exclusively. Production
//! wiring of the macOS Keychain stays in `lib.rs::init_app_state` and is
//! exercised manually via `MEMRY_TEST_REAL_KEYCHAIN=1` in
//! `keychain_memory_test.rs`.

use memry_desktop_tauri_lib::auth::{
    AuthRuntime, AuthStateKind, UnlockedSession,
};
use memry_desktop_tauri_lib::keychain::MemoryKeychain;
use std::sync::Arc;

fn runtime() -> AuthRuntime {
    AuthRuntime::new(Arc::new(MemoryKeychain::new()))
}

fn sample_session(remember_device: bool) -> UnlockedSession {
    UnlockedSession {
        device_id: "device-abc".to_string(),
        email: Some("kaan@example.com".to_string()),
        has_biometric: false,
        remember_device,
        master_key: vec![0x11; 32],
        vault_key: vec![0x22; 32],
    }
}

#[test]
fn default_status_is_locked_with_no_metadata() {
    let auth = runtime();
    let status = auth.status();
    assert_eq!(status.state, AuthStateKind::Locked);
    assert!(status.device_id.is_none());
    assert!(status.email.is_none());
    assert!(!status.has_biometric);
    assert!(!status.remember_device);
}

#[test]
fn begin_unlock_transitions_to_unlocking() {
    let auth = runtime();
    auth.begin_unlock().unwrap();
    assert_eq!(auth.status().state, AuthStateKind::Unlocking);
}

#[test]
fn finish_unlock_stores_metadata_and_transitions_to_unlocked() {
    let auth = runtime();
    auth.begin_unlock().unwrap();
    auth.finish_unlock(sample_session(true)).unwrap();

    let status = auth.status();
    assert_eq!(status.state, AuthStateKind::Unlocked);
    assert_eq!(status.device_id.as_deref(), Some("device-abc"));
    assert_eq!(status.email.as_deref(), Some("kaan@example.com"));
    assert!(status.remember_device);
    assert!(!status.has_biometric);
}

#[test]
fn finish_unlock_makes_master_and_vault_keys_available() {
    let auth = runtime();
    auth.begin_unlock().unwrap();
    auth.finish_unlock(sample_session(false)).unwrap();

    assert_eq!(auth.master_key_clone().as_deref(), Some(&[0x11u8; 32][..]));
    assert_eq!(auth.vault_key_clone().as_deref(), Some(&[0x22u8; 32][..]));
}

#[test]
fn lock_zeroizes_and_drops_in_memory_master_and_vault_keys() {
    let auth = runtime();
    auth.finish_unlock(sample_session(true)).unwrap();
    assert!(auth.master_key_clone().is_some());
    assert!(auth.vault_key_clone().is_some());

    auth.lock().unwrap();

    let status = auth.status();
    assert_eq!(status.state, AuthStateKind::Locked);
    assert!(
        auth.master_key_clone().is_none(),
        "lock must drop the in-memory master key",
    );
    assert!(
        auth.vault_key_clone().is_none(),
        "lock must drop the in-memory vault key",
    );
}

#[test]
fn fail_unlock_transitions_to_error_and_redacts_raw_message() {
    let auth = runtime();
    auth.begin_unlock().unwrap();

    let raw = "wrong password: hunter2-super-secret";
    auth.fail_unlock(raw).unwrap();

    let status = auth.status();
    assert_eq!(status.state, AuthStateKind::Error);

    let stored = auth
        .last_error_message()
        .expect("fail_unlock must record an error class");
    assert_ne!(
        stored, raw,
        "stored error message must not be the raw caller-provided string",
    );
    assert!(
        !stored.contains("hunter2-super-secret"),
        "stored error must not leak password bytes; got {stored:?}",
    );
}

#[test]
fn fail_unlock_drops_any_in_memory_keys() {
    let auth = runtime();
    auth.finish_unlock(sample_session(false)).unwrap();
    assert!(auth.master_key_clone().is_some());

    auth.fail_unlock("network unavailable").unwrap();

    assert!(
        auth.master_key_clone().is_none(),
        "fail_unlock must drop the master key",
    );
    assert!(
        auth.vault_key_clone().is_none(),
        "fail_unlock must drop the vault key",
    );
}

#[test]
fn auth_runtime_exposes_keychain_handle_for_secret_storage() {
    let auth = runtime();
    let keychain = auth.keychain();
    keychain
        .set_item("com.memry.vault", "probe", b"probe-bytes")
        .unwrap();
    let value = keychain.get_item("com.memry.vault", "probe").unwrap();
    assert_eq!(value.as_deref(), Some(b"probe-bytes".as_ref()));
}
