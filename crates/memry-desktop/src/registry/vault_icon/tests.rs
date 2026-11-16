use std::sync::Arc;

use super::*;
use crate::registry::AppConfig;

struct Fixture {
    dir: tempfile::TempDir,
    registry: VaultRegistry,
    vault: String,
}

fn fixture(config: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().expect("dir");
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    if let Some(config) = config {
        std::fs::write(vault.join(".memry/config.json"), config).expect("config");
    }
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("memry-config.json"),
    )));
    let vault = vault.to_string_lossy().into_owned();
    registry.record_open(&vault, 1, 0).expect("register");
    Fixture {
        dir,
        registry,
        vault,
    }
}

fn config_text(f: &Fixture) -> String {
    std::fs::read_to_string(f.dir.path().join("vault/.memry/config.json")).expect("config")
}

const ELECTRON_CONFIG: &str = r##"{
  "excludePatterns": [
    ".git"
  ],
  "defaultNoteFolder": "",
  "preferences": {
    "accentColor": "#ff0000",
    "ratio": 1.5,
    "future": {
      "z": 1,
      "a": 2
    }
  },
  "vaultIcon": {
    "value": "custom:x",
    "updatedAt": 40,
    "pendingSync": false
  },
  "trailing": null
}"##;

#[test]
fn setting_the_icon_keeps_every_other_key_in_value_and_order() {
    let f = fixture(Some(ELECTRON_CONFIG));
    set(&f.registry, &f.vault, Some("icon:Book01Icon"), 100).expect("set");
    let expected = ELECTRON_CONFIG.replace(
        "\"value\": \"custom:x\",\n    \"updatedAt\": 40,\n    \"pendingSync\": false",
        "\"value\": \"icon:Book01Icon\",\n    \"updatedAt\": 100,\n    \"pendingSync\": true",
    );
    assert_eq!(config_text(&f), expected);
}

#[test]
fn an_unreadable_stored_value_reads_as_no_icon_and_keeps_its_change_time() {
    let f = fixture(Some(ELECTRON_CONFIG));
    let icon = read(Path::new(&f.vault)).expect("icon");
    assert_eq!(icon.value, None);
    assert_eq!(icon.updated_at, 40);
    // Resetting still moves past it.
    let next = set(&f.registry, &f.vault, None, 0).expect("reset");
    assert_eq!(next.updated_at, 41);
}

#[test]
fn two_sets_in_one_millisecond_are_strictly_increasing() {
    let f = fixture(None);
    let a = set(&f.registry, &f.vault, Some("🌿"), 1_000).expect("a");
    let b = set(&f.registry, &f.vault, Some("🌱"), 1_000).expect("b");
    let c = set(&f.registry, &f.vault, None, 999).expect("c");
    assert!(a.updated_at < b.updated_at && b.updated_at < c.updated_at);
    assert_eq!(read(Path::new(&f.vault)), Some(c));
}

#[test]
fn an_invalid_icon_is_refused_and_writes_nothing() {
    let f = fixture(Some(ELECTRON_CONFIG));
    for bad in [
        "custom:x",
        &"a".repeat(65),
        "has space",
        "icon:",
        "icon:no-dash",
        "tab\tx",
        "",
    ] {
        assert!(
            matches!(
                set(&f.registry, &f.vault, Some(bad), 5),
                Err(IconError::Invalid)
            ),
            "{bad:?}"
        );
    }
    assert_eq!(config_text(&f), ELECTRON_CONFIG);
}

#[test]
fn only_a_registered_reachable_vault_with_a_readable_config_is_written() {
    let f = fixture(Some("{ broken"));
    assert!(matches!(
        set(&f.registry, &f.vault, Some("🌿"), 5),
        Err(IconError::Unreadable { .. })
    ));
    assert_eq!(config_text(&f), "{ broken");
    assert!(matches!(
        set(&f.registry, "/not/registered", Some("🌿"), 5),
        Err(IconError::NotRegistered(_))
    ));
    std::fs::remove_dir_all(&f.vault).expect("remove");
    assert!(matches!(
        set(&f.registry, &f.vault, Some("🌿"), 5),
        Err(IconError::Unreachable(_))
    ));
}

#[cfg(unix)]
#[test]
fn the_config_file_is_written_with_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(None);
    set(&f.registry, &f.vault, Some("🌿"), 5).expect("set");
    let mode = std::fs::metadata(f.dir.path().join("vault/.memry/config.json"))
        .expect("meta")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn icon_length_counts_utf16_units_like_the_contract() {
    // 16 astral emoji = 32 units: valid. 17 = 34 units: invalid, though only 17 chars.
    assert!(is_valid(&"😀".repeat(16)));
    assert!(!is_valid(&"😀".repeat(17)));
    assert!(is_valid(&format!("icon:{}", "a".repeat(59))));
    assert!(!is_valid(&format!("icon:{}", "a".repeat(60))));
}

/// `vault-directory.ts:173-179`: the push of the change at 6 lands after the user changed the
/// icon again (7); that newer change stays pending, the pushed one clears.
#[test]
fn clear_pending_keeps_a_change_made_during_the_push() {
    let f = fixture(None);
    let vault = Path::new(&f.vault);
    set(&f.registry, &f.vault, Some("🌿"), 6).expect("set");
    set(&f.registry, &f.vault, Some("icon:Book"), 7).expect("set again");

    assert!(!clear_pending(vault, 6).expect("clear"));
    assert_eq!(
        read(vault).map(|i| (i.value, i.updated_at, i.pending_sync)),
        Some((Some("icon:Book".into()), 7, true))
    );

    assert!(clear_pending(vault, 7).expect("clear"));
    assert_eq!(read(vault).map(|i| i.pending_sync), Some(false));
}

/// A value a newer build wrote is kept as written when its change clears.
#[test]
fn clear_pending_keeps_a_value_this_build_cannot_draw() {
    let f = fixture(Some(
        r#"{"vaultIcon":{"value":"custom:new","updatedAt":9,"pendingSync":true}}"#,
    ));
    assert!(clear_pending(Path::new(&f.vault), 9).expect("clear"));
    assert!(config_text(&f).contains("custom:new"));
}

#[test]
fn clear_pending_without_an_icon_writes_no_icon() {
    let f = fixture(None);
    assert!(!clear_pending(Path::new(&f.vault), 1).expect("clear"));
    assert_eq!(read(Path::new(&f.vault)), None);
    assert!(!config_text(&f).contains("vaultIcon"));
}

#[test]
fn adopt_stores_the_account_copy_with_nothing_pending() {
    let f = fixture(None);
    let vault = Path::new(&f.vault);
    set(&f.registry, &f.vault, Some("🌿"), 5).expect("set");
    adopt(vault, None, 900).expect("adopt");
    assert_eq!(
        read(vault),
        Some(StoredVaultIcon {
            value: None,
            updated_at: 900,
            pending_sync: false
        })
    );
}
