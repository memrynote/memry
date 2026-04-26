//! Tests for `auth::secrets`: provider API key set/status/delete.
//!
//! These tests run against the in-memory keychain backend. They verify
//! that:
//! - raw provider keys go into the keychain only, under the canonical
//!   `SERVICE_VAULT` / `provider-key:<provider>` location;
//! - public `ProviderKeyStatus` exposes only masked metadata (no raw key
//!   text in fields or `Debug`);
//! - metadata (`label`, `last4`, `updatedAt`) round-trips through a
//!   separate `provider-key-meta:<provider>` keychain entry that itself
//!   does not contain the raw key;
//! - the allowlist `openai | anthropic | openrouter | google` is enforced;
//! - delete removes both the raw key and the metadata.

use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use memry_desktop_tauri_lib::auth::secrets::{
    delete_provider_key, get_provider_key_status, set_provider_key, ProviderKeyStatus,
    ALLOWED_PROVIDERS,
};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::keychain::{KeychainStore, MemoryKeychain, SERVICE_VAULT};

const RAW_KEY: &str = "sk-test-1234567890ABCD";

fn fixed_now() -> std::time::SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_700_000_000)
}

fn store() -> Arc<MemoryKeychain> {
    Arc::new(MemoryKeychain::new())
}

#[test]
fn set_provider_key_stores_raw_value_in_keychain_under_canonical_account() {
    let kc = store();
    set_provider_key(
        kc.as_ref(),
        "openai",
        RAW_KEY,
        Some("Personal".to_string()),
        fixed_now(),
    )
    .unwrap();

    let stored = kc
        .get_item(SERVICE_VAULT, "provider-key:openai")
        .unwrap()
        .expect("raw key must be stored under provider-key:<provider>");
    assert_eq!(
        stored,
        RAW_KEY.as_bytes(),
        "raw key bytes must match exactly",
    );
}

#[test]
fn set_provider_key_returns_status_with_configured_and_masked_metadata() {
    let kc = store();
    let status = set_provider_key(
        kc.as_ref(),
        "openai",
        RAW_KEY,
        Some("Personal".to_string()),
        fixed_now(),
    )
    .unwrap();

    assert_eq!(status.provider, "openai");
    assert!(status.configured);
    assert_eq!(status.label.as_deref(), Some("Personal"));
    assert_eq!(
        status.last4.as_deref(),
        Some("ABCD"),
        "last4 must be the last four characters of the raw key",
    );
    assert!(
        status.updated_at.is_some(),
        "updated_at must be populated on set",
    );
}

#[test]
fn provider_key_status_debug_does_not_contain_raw_key_bytes() {
    let kc = store();
    let status = set_provider_key(
        kc.as_ref(),
        "openai",
        RAW_KEY,
        Some("Personal".to_string()),
        fixed_now(),
    )
    .unwrap();

    let dbg = format!("{status:?}");
    assert!(
        !dbg.contains(RAW_KEY),
        "Debug output must not leak raw provider key; got: {dbg}",
    );
    assert!(
        !dbg.contains("sk-test-1234567890"),
        "Debug output must not leak any partial raw key body; got: {dbg}",
    );
}

#[test]
fn get_provider_key_status_returns_not_configured_when_absent() {
    let kc = store();
    let status = get_provider_key_status(kc.as_ref(), "openai").unwrap();

    assert_eq!(status.provider, "openai");
    assert!(
        !status.configured,
        "absent provider key must return configured=false",
    );
    assert!(status.label.is_none());
    assert!(status.last4.is_none());
    assert!(status.updated_at.is_none());
}

#[test]
fn get_provider_key_status_round_trips_metadata_after_set() {
    let kc = store();
    set_provider_key(
        kc.as_ref(),
        "anthropic",
        "sk-ant-abcdEFGH",
        Some("Work".to_string()),
        fixed_now(),
    )
    .unwrap();

    let status = get_provider_key_status(kc.as_ref(), "anthropic").unwrap();

    assert_eq!(status.provider, "anthropic");
    assert!(status.configured);
    assert_eq!(status.label.as_deref(), Some("Work"));
    assert_eq!(status.last4.as_deref(), Some("EFGH"));
    let updated = status.updated_at.expect("updated_at must round-trip");
    assert!(
        updated.starts_with("2023-"),
        "updated_at must be ISO-8601 string anchored to fixed_now(); got {updated}",
    );
}

#[test]
fn delete_provider_key_removes_raw_key_and_metadata() {
    let kc = store();
    set_provider_key(
        kc.as_ref(),
        "google",
        "AIzaSyAbcd1234",
        Some("Family".to_string()),
        fixed_now(),
    )
    .unwrap();

    delete_provider_key(kc.as_ref(), "google").unwrap();

    assert!(
        kc.get_item(SERVICE_VAULT, "provider-key:google")
            .unwrap()
            .is_none(),
        "raw provider key must be removed from keychain after delete",
    );
    assert!(
        kc.get_item(SERVICE_VAULT, "provider-key-meta:google")
            .unwrap()
            .is_none(),
        "provider key metadata must be removed from keychain after delete",
    );

    let status = get_provider_key_status(kc.as_ref(), "google").unwrap();
    assert!(
        !status.configured,
        "after delete, status must report configured=false",
    );
    assert!(status.last4.is_none());
    assert!(status.label.is_none());
    assert!(status.updated_at.is_none());
}

#[test]
fn delete_provider_key_on_missing_provider_is_ok() {
    let kc = store();
    let result = delete_provider_key(kc.as_ref(), "openrouter");
    assert!(
        result.is_ok(),
        "deleting a never-set provider key must be Ok(()), got {result:?}",
    );
}

#[test]
fn set_provider_key_rejects_unknown_provider() {
    let kc = store();
    let result = set_provider_key(
        kc.as_ref(),
        "evil-corp",
        RAW_KEY,
        None,
        fixed_now(),
    );

    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("evil-corp") || msg.contains("provider"),
                "validation error must mention the rejected provider; got {msg}",
            );
            assert!(
                !msg.contains(RAW_KEY),
                "validation error must not leak raw key; got {msg}",
            );
        }
        other => panic!("expected AppError::Validation, got {other:?}"),
    }

    assert!(
        kc.get_item(SERVICE_VAULT, "provider-key:evil-corp")
            .unwrap()
            .is_none(),
        "rejected provider must not write any keychain item",
    );
}

#[test]
fn get_provider_key_status_rejects_unknown_provider() {
    let kc = store();
    let result = get_provider_key_status(kc.as_ref(), "evil-corp");
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "status for unknown provider must be a validation error, got {result:?}",
    );
}

#[test]
fn delete_provider_key_rejects_unknown_provider() {
    let kc = store();
    let result = delete_provider_key(kc.as_ref(), "evil-corp");
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "delete for unknown provider must be a validation error, got {result:?}",
    );
}

#[test]
fn allowlist_contains_exactly_the_four_supported_providers() {
    let mut providers: Vec<&str> = ALLOWED_PROVIDERS.to_vec();
    providers.sort();
    assert_eq!(
        providers,
        vec!["anthropic", "google", "openai", "openrouter"],
        "allowlist must be exactly openai, anthropic, openrouter, google",
    );
}

#[test]
fn set_provider_key_accepts_all_four_allowlisted_providers() {
    for &provider in ALLOWED_PROVIDERS {
        let kc = store();
        let status = set_provider_key(
            kc.as_ref(),
            provider,
            "raw-key-WXYZ",
            None,
            fixed_now(),
        )
        .unwrap_or_else(|err| panic!("set must succeed for {provider}, got {err:?}"));
        assert_eq!(status.provider, provider);
        assert!(status.configured);
    }
}

#[test]
fn provider_key_metadata_keychain_entry_does_not_contain_raw_key() {
    let kc = store();
    set_provider_key(
        kc.as_ref(),
        "openai",
        RAW_KEY,
        Some("Personal".to_string()),
        fixed_now(),
    )
    .unwrap();

    let meta_bytes = kc
        .get_item(SERVICE_VAULT, "provider-key-meta:openai")
        .unwrap()
        .expect("metadata must be stored under provider-key-meta:<provider>");
    let meta_str = String::from_utf8(meta_bytes).expect("metadata must be utf-8 json");
    assert!(
        !meta_str.contains(RAW_KEY),
        "metadata json must not contain raw key bytes; got {meta_str}",
    );
    assert!(
        !meta_str.contains("sk-test-1234567890"),
        "metadata json must not contain partial raw key body; got {meta_str}",
    );
}

#[test]
fn last4_is_full_key_when_key_is_short() {
    let kc = store();
    let status = set_provider_key(
        kc.as_ref(),
        "openai",
        "ab",
        None,
        fixed_now(),
    )
    .unwrap();
    assert_eq!(
        status.last4.as_deref(),
        Some("ab"),
        "keys shorter than 4 chars produce last4 = whole key",
    );
}

#[test]
fn provider_key_status_serializes_with_camel_case_fields() {
    let status = ProviderKeyStatus {
        provider: "openai".to_string(),
        configured: true,
        label: Some("Personal".to_string()),
        last4: Some("ABCD".to_string()),
        updated_at: Some("2023-11-14T22:13:20Z".to_string()),
    };
    let json = serde_json::to_string(&status).unwrap();
    assert!(
        json.contains("\"updatedAt\""),
        "serialised JSON must use camelCase updatedAt; got {json}",
    );
    assert!(
        json.contains("\"last4\""),
        "serialised JSON must contain last4; got {json}",
    );
    assert!(
        !json.contains("updated_at"),
        "serialised JSON must not contain snake_case updated_at; got {json}",
    );
}
