//! Tests for `auth::device` (Task 12) and `auth::account` device upsert
//! and sign-out (Task 12). Linking-related tests are added in Task 14.
//!
//! All tests use the in-memory keychain backend and a memory-only sqlite
//! database. Production wires up the macOS Keychain in
//! `lib.rs::init_app_state`.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use memry_desktop_tauri_lib::app_state::AppState;
use memry_desktop_tauri_lib::auth::account::{
    self, AccountInfo, ACCOUNT_AUTH_PROVIDER, ACCOUNT_EMAIL,
    ACCOUNT_RECOVERY_CONFIRMED, ACCOUNT_USER_ID,
};
use memry_desktop_tauri_lib::auth::device::{
    self, CurrentDeviceRecord, KEYCHAIN_DEVICE_SIGNING_KEY,
};
use memry_desktop_tauri_lib::auth::AuthRuntime;
use memry_desktop_tauri_lib::crypto::sign_verify::{
    device_id_from_public_key, verify_detached,
};
use memry_desktop_tauri_lib::db::{settings, Db};
use memry_desktop_tauri_lib::keychain::{
    KeychainStore, MemoryKeychain, SERVICE_DEVICE, SERVICE_VAULT,
};
use memry_desktop_tauri_lib::vault::VaultRuntime;

const KEYCHAIN_ACCESS_TOKEN: &str = "access-token";
const KEYCHAIN_REFRESH_TOKEN: &str = "refresh-token";
const KEYCHAIN_SETUP_TOKEN: &str = "setup-token";
const KEYCHAIN_MASTER_KEY: &str = "master-key";
const KEYCHAIN_RECOVERY_PHRASE: &str = "recovery-phrase";

fn fresh_state() -> AppState {
    let db = Db::open_memory().expect("memory db must open");
    let vault = Arc::new(VaultRuntime::boot().expect("vault runtime must boot"));
    let keychain: Arc<dyn KeychainStore> = Arc::new(MemoryKeychain::new());
    let auth = Arc::new(AuthRuntime::new(keychain));
    AppState::new(db, vault, auth)
}

// ---------------------------------------------------------------------
// Task 12: device signing key
// ---------------------------------------------------------------------

#[test]
fn get_or_create_device_signing_key_creates_keychain_item_when_missing() {
    let state = fresh_state();

    let kp = device::get_or_create_device_signing_key(&state).expect("key creation must succeed");

    assert_eq!(kp.public_key.len(), 32, "public key must be 32 bytes");
    assert_eq!(kp.secret_key.len(), 64, "ed25519 secret key must be 64 bytes");

    let stored = state
        .auth
        .keychain()
        .get_item(SERVICE_DEVICE, KEYCHAIN_DEVICE_SIGNING_KEY)
        .unwrap();
    assert!(
        stored.is_some(),
        "first call must persist signing key under SERVICE_DEVICE/device-signing-key",
    );
    assert_eq!(
        stored.as_ref().map(|b| b.len()),
        Some(64),
        "stored ed25519 secret key must be 64 bytes",
    );
}

#[test]
fn get_or_create_device_signing_key_reuses_existing_key() {
    let state = fresh_state();

    let first = device::get_or_create_device_signing_key(&state).unwrap();
    let second = device::get_or_create_device_signing_key(&state).unwrap();

    assert_eq!(
        first.public_key, second.public_key,
        "subsequent calls must reuse the stored key, not generate a new one",
    );
    assert_eq!(first.secret_key, second.secret_key);
}

#[test]
fn device_id_for_keypair_matches_blake2b_hash_of_public_key() {
    let state = fresh_state();
    let kp = device::get_or_create_device_signing_key(&state).unwrap();

    let from_helper = device::device_id_for_keypair(&kp).unwrap();
    let expected = device_id_from_public_key(&kp.public_key).unwrap();

    assert_eq!(from_helper, expected, "device id must derive via Phase A helper");
    assert_eq!(from_helper.len(), 32, "device id is 16-byte hex");
}

#[test]
fn sign_device_challenge_returns_base64_signature_that_verifies() {
    let state = fresh_state();
    let kp = device::get_or_create_device_signing_key(&state).unwrap();
    let challenge = "auth-server-nonce-abc123";

    let signature_b64 = device::sign_device_challenge(&kp.secret_key, challenge).unwrap();

    let bytes = B64
        .decode(&signature_b64)
        .expect("signature must be base64-encoded");
    assert_eq!(bytes.len(), 64, "ed25519 signature must be 64 bytes");

    verify_detached(challenge.as_bytes(), &bytes, &kp.public_key)
        .expect("signature must verify against the matching public key");
}

#[test]
fn sign_device_challenge_rejects_wrong_length_secret_key() {
    let too_short = vec![0u8; 32];

    let err = device::sign_device_challenge(&too_short, "challenge").unwrap_err();

    assert!(
        format!("{err}").to_lowercase().contains("secret key"),
        "wrong-length secret key must surface a crypto error mentioning secret key, got {err}",
    );
}

// ---------------------------------------------------------------------
// Task 12: current device upsert
// ---------------------------------------------------------------------

fn sample_device(id: &str, name: &str, signing_pk: &str) -> CurrentDeviceRecord {
    CurrentDeviceRecord {
        id: id.to_string(),
        name: name.to_string(),
        platform: "macos".to_string(),
        os_version: Some("14.5".to_string()),
        app_version: "2.0.0".to_string(),
        linked_at: 1_700_000_000,
        signing_public_key: signing_pk.to_string(),
    }
}

#[test]
fn upsert_current_device_inserts_row_marked_as_current() {
    let state = fresh_state();
    let record = sample_device("device-1", "Alice MacBook", "pk-bytes-1");

    device::upsert_current_device(&state, record).unwrap();

    let conn = state.db.conn().unwrap();
    let (name, platform, is_current): (String, String, i64) = conn
        .query_row(
            "SELECT name, platform, is_current_device FROM sync_devices WHERE id = ?1",
            rusqlite::params!["device-1"],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(name, "Alice MacBook");
    assert_eq!(platform, "macos");
    assert_eq!(is_current, 1, "is_current_device must be 1 for the local device");
}

#[test]
fn upsert_current_device_updates_existing_row_without_duplication() {
    let state = fresh_state();
    let mut record = sample_device("device-1", "Old Name", "pk-bytes-1");
    device::upsert_current_device(&state, record.clone()).unwrap();

    record.name = "Renamed".to_string();
    device::upsert_current_device(&state, record).unwrap();

    let conn = state.db.conn().unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_devices WHERE id = ?1",
            rusqlite::params!["device-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "upsert must replace, not duplicate");

    let name: String = conn
        .query_row(
            "SELECT name FROM sync_devices WHERE id = ?1",
            rusqlite::params!["device-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "Renamed");
}

#[test]
fn upsert_current_device_unsets_is_current_flag_on_other_devices() {
    let state = fresh_state();

    {
        let conn = state.db.conn().unwrap();
        conn.execute(
            "INSERT INTO sync_devices(id, name, platform, app_version, linked_at, is_current_device, signing_public_key)
             VALUES('peer-device', 'Peer', 'linux', '1.0.0', 1, 1, 'peer-pk')",
            [],
        )
        .unwrap();
    }

    let record = sample_device("device-1", "Local", "pk-bytes-1");
    device::upsert_current_device(&state, record).unwrap();

    let conn = state.db.conn().unwrap();
    let peer_flag: i64 = conn
        .query_row(
            "SELECT is_current_device FROM sync_devices WHERE id = 'peer-device'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        peer_flag, 0,
        "upserting the current device must clear is_current_device on others",
    );

    let local_flag: i64 = conn
        .query_row(
            "SELECT is_current_device FROM sync_devices WHERE id = 'device-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(local_flag, 1);
}

// ---------------------------------------------------------------------
// Task 12: account info storage
// ---------------------------------------------------------------------

#[test]
fn get_account_info_returns_none_when_settings_absent() {
    let state = fresh_state();

    let info = account::get_account_info(&state).unwrap();

    assert!(info.is_none(), "fresh state has no persisted account info");
}

#[test]
fn set_account_info_persists_to_canonical_settings_keys() {
    let state = fresh_state();

    let info = AccountInfo {
        user_id: "user-123".to_string(),
        email: "kaan@example.com".to_string(),
        auth_provider: "otp".to_string(),
    };
    account::set_account_info(&state, &info).unwrap();

    assert_eq!(
        settings::get(&state.db, ACCOUNT_USER_ID).unwrap().as_deref(),
        Some("user-123"),
    );
    assert_eq!(
        settings::get(&state.db, ACCOUNT_EMAIL).unwrap().as_deref(),
        Some("kaan@example.com"),
    );
    assert_eq!(
        settings::get(&state.db, ACCOUNT_AUTH_PROVIDER)
            .unwrap()
            .as_deref(),
        Some("otp"),
    );
}

#[test]
fn get_account_info_round_trips_after_set() {
    let state = fresh_state();
    let info = AccountInfo {
        user_id: "u-1".to_string(),
        email: "a@b.com".to_string(),
        auth_provider: "google".to_string(),
    };
    account::set_account_info(&state, &info).unwrap();

    let loaded = account::get_account_info(&state).unwrap().unwrap();

    assert_eq!(loaded.user_id, info.user_id);
    assert_eq!(loaded.email, info.email);
    assert_eq!(loaded.auth_provider, info.auth_provider);
}

#[test]
fn recovery_confirmed_defaults_to_false_and_persists() {
    let state = fresh_state();
    assert!(
        !account::get_recovery_confirmed(&state).unwrap(),
        "recovery confirmation must default false",
    );

    account::set_recovery_confirmed(&state, true).unwrap();

    assert!(account::get_recovery_confirmed(&state).unwrap());
    assert_eq!(
        settings::get(&state.db, ACCOUNT_RECOVERY_CONFIRMED)
            .unwrap()
            .as_deref(),
        Some("true"),
    );
}

// ---------------------------------------------------------------------
// Task 12: sign-out clears auth tokens, leaves vault data
// ---------------------------------------------------------------------

#[test]
fn sign_out_clears_access_refresh_setup_tokens_but_leaves_vault_data() {
    let state = fresh_state();
    let kc = state.auth.keychain();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, b"access").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, b"refresh").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN, b"setup").unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY, &[0x11u8; 32]).unwrap();
    kc.set_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE, b"phrase").unwrap();

    account::sign_out(&state).unwrap();

    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN).unwrap().is_none(),
        "sign-out must remove the access token",
    );
    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN)
            .unwrap()
            .is_none(),
        "sign-out must remove the refresh token",
    );
    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)
            .unwrap()
            .is_none(),
        "sign-out must remove the setup token",
    );

    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_MASTER_KEY).unwrap().is_some(),
        "sign-out must NOT delete the local master key",
    );
    assert!(
        kc.get_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE)
            .unwrap()
            .is_some(),
        "sign-out must NOT delete the recovery phrase",
    );
}
