//! Tests for the in-memory `KeychainStore` backend used in unit tests, plus
//! an ignored manual smoke that exercises the real macOS Keychain backend.
//!
//! The non-ignored tests must never touch the real OS Keychain. They only
//! verify trait contract: set/get/delete round-trips, overwrite semantics,
//! independence between (service, account) pairs, and that returned bytes
//! are cloned copies that callers can mutate without disturbing the store.

use memry_desktop_tauri_lib::keychain::{
    MemoryKeychain, KeychainStore, SERVICE_DEVICE, SERVICE_VAULT,
};

#[test]
fn service_constants_match_canonical_identifiers() {
    assert_eq!(SERVICE_VAULT, "com.memry.vault");
    assert_eq!(SERVICE_DEVICE, "com.memry.device");
}

#[test]
fn set_then_get_round_trips_bytes() {
    let store = MemoryKeychain::new();
    store
        .set_item(SERVICE_VAULT, "master-key", b"secret-bytes")
        .unwrap();

    let value = store.get_item(SERVICE_VAULT, "master-key").unwrap();
    assert_eq!(value.as_deref(), Some(b"secret-bytes".as_ref()));
}

#[test]
fn get_returns_none_for_missing_account() {
    let store = MemoryKeychain::new();
    let value = store.get_item(SERVICE_VAULT, "master-key").unwrap();
    assert!(value.is_none(), "missing account must be Ok(None), got {value:?}");
}

#[test]
fn overwriting_an_account_replaces_the_bytes() {
    let store = MemoryKeychain::new();
    store
        .set_item(SERVICE_VAULT, "master-key", b"original")
        .unwrap();
    store
        .set_item(SERVICE_VAULT, "master-key", b"updated-bytes")
        .unwrap();

    let value = store.get_item(SERVICE_VAULT, "master-key").unwrap();
    assert_eq!(value.as_deref(), Some(b"updated-bytes".as_ref()));
}

#[test]
fn delete_removes_item_and_subsequent_get_is_none() {
    let store = MemoryKeychain::new();
    store
        .set_item(SERVICE_VAULT, "master-key", b"will-be-removed")
        .unwrap();

    store.delete_item(SERVICE_VAULT, "master-key").unwrap();

    let value = store.get_item(SERVICE_VAULT, "master-key").unwrap();
    assert!(value.is_none(), "deleted account must be None");
}

#[test]
fn delete_on_missing_account_is_ok() {
    let store = MemoryKeychain::new();
    let result = store.delete_item(SERVICE_VAULT, "never-existed");
    assert!(
        result.is_ok(),
        "deleting a missing item must be Ok(()), got {result:?}",
    );
}

#[test]
fn service_and_account_isolate_items() {
    let store = MemoryKeychain::new();
    store
        .set_item(SERVICE_VAULT, "master-key", b"vault-secret")
        .unwrap();
    store
        .set_item(SERVICE_DEVICE, "master-key", b"device-secret")
        .unwrap();
    store
        .set_item(SERVICE_VAULT, "other-account", b"other-secret")
        .unwrap();

    let vault_master = store.get_item(SERVICE_VAULT, "master-key").unwrap();
    let device_master = store.get_item(SERVICE_DEVICE, "master-key").unwrap();
    let vault_other = store.get_item(SERVICE_VAULT, "other-account").unwrap();

    assert_eq!(vault_master.as_deref(), Some(b"vault-secret".as_ref()));
    assert_eq!(device_master.as_deref(), Some(b"device-secret".as_ref()));
    assert_eq!(vault_other.as_deref(), Some(b"other-secret".as_ref()));

    store.delete_item(SERVICE_VAULT, "master-key").unwrap();

    assert!(
        store
            .get_item(SERVICE_VAULT, "master-key")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .get_item(SERVICE_DEVICE, "master-key")
            .unwrap()
            .as_deref(),
        Some(b"device-secret".as_ref()),
        "deleting from one service must not touch another service"
    );
    assert_eq!(
        store
            .get_item(SERVICE_VAULT, "other-account")
            .unwrap()
            .as_deref(),
        Some(b"other-secret".as_ref()),
        "deleting one account must not touch other accounts in the same service",
    );
}

#[test]
fn returned_bytes_are_cloned_copies_callers_cannot_mutate_store() {
    let store = MemoryKeychain::new();
    store
        .set_item(SERVICE_VAULT, "master-key", b"original")
        .unwrap();

    let mut first = store
        .get_item(SERVICE_VAULT, "master-key")
        .unwrap()
        .expect("item must exist");
    first.clear();
    first.extend_from_slice(b"tampered");

    let second = store
        .get_item(SERVICE_VAULT, "master-key")
        .unwrap()
        .expect("item must still exist");
    assert_eq!(
        second, b"original",
        "store must hold its own copy; mutating the returned Vec must not change later reads",
    );
}

/// Manual smoke against the real macOS Keychain. Skipped by default to keep
/// CI hermetic. Requires `MEMRY_TEST_REAL_KEYCHAIN=1` and writes to
/// `com.memry.vault` for a unique account name. Cleans up after itself.
#[test]
#[ignore = "writes to macOS Keychain; run with MEMRY_TEST_REAL_KEYCHAIN=1"]
fn real_keychain_round_trip() {
    use memry_desktop_tauri_lib::keychain::MacosKeychain;

    if std::env::var("MEMRY_TEST_REAL_KEYCHAIN").ok().as_deref() != Some("1") {
        eprintln!("MEMRY_TEST_REAL_KEYCHAIN!=1; skipping real Keychain round-trip");
        return;
    }

    let store = MacosKeychain::new();
    let account = format!(
        "memry-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let payload = b"memry-keychain-smoke-payload";

    let cleanup = || {
        let _ = store.delete_item(SERVICE_VAULT, &account);
    };

    cleanup();

    store
        .set_item(SERVICE_VAULT, &account, payload)
        .expect("set_item must succeed against the real Keychain");

    let value = store
        .get_item(SERVICE_VAULT, &account)
        .expect("get_item must succeed against the real Keychain");
    assert_eq!(
        value.as_deref(),
        Some(payload.as_ref()),
        "round-trip bytes must match",
    );

    store
        .delete_item(SERVICE_VAULT, &account)
        .expect("delete_item must succeed against the real Keychain");

    let after_delete = store.get_item(SERVICE_VAULT, &account).expect(
        "get_item after delete must succeed (and return Ok(None), not an error)",
    );
    assert!(
        after_delete.is_none(),
        "after delete the item must be Ok(None), got {after_delete:?}",
    );
}
