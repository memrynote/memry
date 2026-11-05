//! The vault settings through `vault:get-config` and `vault:update-config`'s owner
//! (`vault::config::settings`), on a real `config.json`: Electron's `getConfig` and
//! `updateConfig`, but for the changes that are not ported yet (Step 13m-7b), which are refused
//! and leave the file as it was.

use std::fs;
use std::path::Path;

use memry_desktop::vault::config::settings::{
    SettingsError, update_vault_settings, vault_settings,
};
use memry_desktop::vault::config::{VaultConfig, VaultConfigPatch, config_path};
use serde_json::{Value, json};

fn vault_with(config: Value) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    fs::write(
        config_path(dir.path()),
        serde_json::to_vec_pretty(&config).unwrap(),
    )
    .unwrap();
    dir
}

fn stored(vault: &Path) -> Value {
    serde_json::from_slice(&fs::read(config_path(vault)).unwrap()).unwrap()
}

#[test]
fn a_read_gives_the_journal_settings_in_their_canonical_form() {
    let dir = vault_with(json!({
        "journalFolder": "/Daily Notes/",
        "journalDateFormat": " YYYY\\YYYY-MM-DD ",
        "journalShowInSidebar": "yes"
    }));
    let settings = vault_settings(Some(dir.path()));
    assert_eq!(settings.journal_folder, "Daily Notes");
    assert_eq!(settings.journal_date_format, "YYYY/YYYY-MM-DD");
    assert!(!settings.journal_show_in_sidebar);
    assert_eq!(settings.attachments_folder, "attachments");
}

/// With no vault open Electron answers a fallback whose exclude patterns are empty, unlike a
/// new vault's.
#[test]
fn with_no_vault_open_the_fallback_has_no_exclude_patterns() {
    let settings = vault_settings(None);
    assert_eq!(
        settings,
        VaultConfig {
            exclude_patterns: Vec::new(),
            ..VaultConfig::default()
        }
    );
}

#[test]
fn an_update_writes_the_fields_it_names_and_keeps_the_rest_of_the_file() {
    let dir = vault_with(json!({
        "journalFolder": "diary",
        "preferences": {"theme": "dark"},
        "newerBuild": [1, 2]
    }));
    let patch = VaultConfigPatch {
        default_note_folder: Some("inbox".to_owned()),
        journal_show_in_sidebar: Some(true),
        attachments_folder: Some("files".to_owned()),
        ..VaultConfigPatch::default()
    };
    let settings = update_vault_settings(dir.path(), patch).unwrap();
    assert_eq!(settings.default_note_folder, "inbox");
    assert!(settings.journal_show_in_sidebar);
    assert_eq!(settings.attachments_folder, "files");
    let file = stored(dir.path());
    assert_eq!(file["journalFolder"], "diary");
    assert_eq!(file["preferences"], json!({"theme": "dark"}));
    assert_eq!(file["newerBuild"], json!([1, 2]));
    assert_eq!(file["defaultNoteFolder"], "inbox");
}

/// A change the tier cannot follow yet is refused whole, and the file is left as it was; the
/// current value again (in any spelling that normalizes to it) is no change.
#[test]
fn a_change_of_the_journal_folder_the_format_or_the_excludes_is_refused() {
    let dir = vault_with(json!({
        "journalFolder": "/diary/",
        "journalDateFormat": "YYYY-MM-DD",
        "excludePatterns": [".git"]
    }));
    let before = fs::read(config_path(dir.path())).unwrap();
    let refused = [
        (
            "journalFolder",
            VaultConfigPatch {
                journal_folder: Some("Diary".to_owned()),
                ..Default::default()
            },
        ),
        (
            "journalDateFormat",
            VaultConfigPatch {
                journal_date_format: Some("DD-MM-YYYY".to_owned()),
                ..Default::default()
            },
        ),
        (
            "excludePatterns",
            VaultConfigPatch {
                exclude_patterns: Some(vec![]),
                ..Default::default()
            },
        ),
    ];
    for (key, patch) in refused {
        let patch = VaultConfigPatch {
            journal_show_in_sidebar: Some(true),
            ..patch
        };
        match update_vault_settings(dir.path(), patch) {
            Err(SettingsError::NotPorted(refused)) => assert_eq!(refused, key),
            other => panic!("{key}: {other:?}"),
        }
        assert_eq!(fs::read(config_path(dir.path())).unwrap(), before, "{key}");
    }

    let same = VaultConfigPatch {
        journal_folder: Some("diary/".to_owned()),
        journal_date_format: Some(" YYYY-MM-DD".to_owned()),
        exclude_patterns: Some(vec![".git".to_owned()]),
        journal_show_in_sidebar: Some(true),
        ..VaultConfigPatch::default()
    };
    let settings = update_vault_settings(dir.path(), same).unwrap();
    assert!(settings.journal_show_in_sidebar);
    assert_eq!(stored(dir.path())["journalFolder"], "/diary/");
}

/// The input is `UpdateVaultConfigSchema`: every field optional, an unknown key ignored.
#[test]
fn an_update_reads_the_contracts_shape() {
    let patch: VaultConfigPatch =
        serde_json::from_value(json!({"journalShowInSidebar": true, "unknown": 1})).unwrap();
    assert_eq!(
        patch,
        VaultConfigPatch {
            journal_show_in_sidebar: Some(true),
            ..VaultConfigPatch::default()
        }
    );
    assert!(
        serde_json::from_value::<VaultConfigPatch>(json!({"journalShowInSidebar": "yes"})).is_err()
    );
    let wire = serde_json::to_value(VaultConfig::default()).unwrap();
    assert_eq!(
        wire.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "excludePatterns",
            "defaultNoteFolder",
            "journalFolder",
            "journalDateFormat",
            "attachmentsFolder",
            "journalShowInSidebar"
        ]
    );
}
