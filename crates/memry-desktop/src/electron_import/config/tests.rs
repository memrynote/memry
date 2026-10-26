use super::*;
use crate::electron_import::tests::macos_fixture;

#[test]
fn reads_the_captured_config_and_keeps_unknown_keys() {
    let f = macos_fixture("new");
    let config = ElectronConfig::read(&f.profile).unwrap().unwrap();
    assert_eq!(config.current_vault(), Some("/Users/fixture/vault"));
    assert_eq!(config.locale(), Some("tr"));
    assert_eq!(config.device_id(), Some("device-fixture"));
    assert_eq!(config.email(), Some("fixture@example.com"));
    assert_eq!(config.recovery_phrase_confirmed(), Some(true));
    assert_eq!(config.account_key_verifier(), None);
    let (vaults, _) = config.vaults();
    assert_eq!(vaults.len(), 1);
    assert_eq!(
        vaults[0].vault_uuid.as_deref(),
        Some(f.expected.vault_uuid.as_str())
    );
    assert!(vaults[0].is_default);
    assert_eq!(config.section("futureSetting").unwrap()["kept"], true);
}

#[test]
fn missing_file_is_none() {
    let mut f = macos_fixture("new");
    std::fs::remove_file(f.profile.config_path()).unwrap();
    f.profile.has_config = false;
    assert!(ElectronConfig::read(&f.profile).unwrap().is_none());
}

#[test]
fn invalid_json_reports_an_offset_and_no_content() {
    let err = ElectronConfig::parse(b"{\n  \"vaults\": [oops-secret-token]\n}").unwrap_err();
    let ImportError::Parse { offset, .. } = err else {
        panic!("{err:?}")
    };
    assert!((13..=30).contains(&offset), "{offset}");
    assert!(!err.to_string().contains("secret-token"));
    assert!(ElectronConfig::parse(b"[1]").is_err());
}

#[test]
fn older_shapes_read_as_absent() {
    let config =
        ElectronConfig::parse(br#"{"vaults":[{"path":"/a"},{"name":"no path"},7],"sync":"x"}"#)
            .unwrap();
    let (vaults, _) = config.vaults();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].name, None);
    assert_eq!(config.device_id(), None);
    assert_eq!(config.current_vault(), None);
}

#[test]
fn a_wrong_typed_field_costs_the_field_not_the_vault_and_skips_are_counted() {
    let config = ElectronConfig::parse(
        br#"{"vaults":[{"path":"/a","noteCount":"many","isDefault":"yes","vaultUuid":"u"},{"name":"no path"},7]}"#,
    )
    .unwrap();
    let (vaults, skipped) = config.vaults();
    assert_eq!(skipped, 2);
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].note_count, None);
    assert!(!vaults[0].is_default);
    assert_eq!(vaults[0].vault_uuid.as_deref(), Some("u"));
}

#[test]
fn crdt_store_bookkeeping_is_read_for_the_migration() {
    let config = ElectronConfig::parse(
        br#"{"crdtStore":{"pendingRenames":{"new":"old"},"legacyStoreClaimedBy":"v1","legacyStorePartitionPendingFor":"v1"}}"#,
    )
    .unwrap();
    assert_eq!(config.crdt_pending_rename("new"), Some("old"));
    assert_eq!(config.crdt_pending_rename("other"), None);
    assert_eq!(config.legacy_store_claimed_by(), Some("v1"));
    assert_eq!(config.legacy_store_partition_pending_for(), Some("v1"));
    let bare = ElectronConfig::parse(b"{}").unwrap();
    assert_eq!(bare.legacy_store_claimed_by(), None);
}
