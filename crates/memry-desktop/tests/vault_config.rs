//! `<vault>/.memry/config.json` is shared with the Electron build and with other builds of this
//! app. Through the real owner: nothing the writer does not own changes, a file it cannot
//! parse is never replaced, and a hostile file cannot stall or crash a read.

use std::fs;
use std::path::Path;

use memry_desktop::vault::config::{
    ConfigError, MAX_CONFIG_BYTES, VaultConfig, VaultConfigPatch, config_path,
    has_stored_preferences, invalidate_vault_config_cache, merge_preferences, preferences_language,
    read_preferences, read_vault_config, read_vault_icon, write_vault_config, write_vault_icon,
};
use serde_json::{Map, Value, json};

fn vault_with(config: &[u8]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    fs::write(config_path(dir.path()), config).unwrap();
    dir
}

fn none() -> Map<String, Value> {
    Map::new()
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn bytes(vault: &Path) -> Vec<u8> {
    fs::read(config_path(vault)).unwrap()
}

/// What Electron's `initVault` and later writers leave: the settings, then `preferences`, the
/// icon and a key only a newer build knows.
const ELECTRON: &str = r##"{
  "excludePatterns": [
    ".git"
  ],
  "defaultNoteFolder": "inbox",
  "journalFolder": "diary",
  "journalDateFormat": "YYYY-MM-DD",
  "attachmentsFolder": "attachments",
  "journalShowInSidebar": true,
  "preferences": {
    "theme": "dark",
    "future": { "z": 1, "a": 2 },
    "editor": { "width": "wide", "x": 1 }
  },
  "vaultIcon": { "value": "icon:Book01Icon", "updatedAt": 40, "pendingSync": false },
  "newerBuild": [1, 2]
}"##;

#[test]
fn legacy_values_coerce_and_a_missing_font_px_comes_from_the_bucket() {
    let dir = vault_with(
        br#"{"preferences":{"theme":"light","fontSize":"large","editor":{"width":"wide"}}}"#,
    );
    let (general, editor) = read_preferences(dir.path(), &none(), &none()).expect("stored");
    assert_eq!(general["fontSizePx"], 20);
    assert_eq!(general["colorTheme"], "warm");
    assert_eq!(editor["width"], "normal");
    let dir = vault_with(br#"{"preferences":{"fontSizePx":13,"fontSize":"large"}}"#);
    assert_eq!(
        read_preferences(dir.path(), &none(), &none()).unwrap().0["fontSizePx"],
        20,
        "an incoherent pair follows the bucket"
    );
    let dir = vault_with(br#"{"preferences":{"fontSizePx":16.4,"fontSize":"medium"}}"#);
    assert_eq!(
        read_preferences(dir.path(), &none(), &none()).unwrap().0["fontSizePx"],
        16
    );
}

#[test]
fn no_writer_replaces_a_config_it_cannot_parse() {
    let general = object(json!({"theme": "dark"}));
    let too_big = vec![b' '; usize::try_from(MAX_CONFIG_BYTES).unwrap() + 1];
    for corrupt in [
        b"{not json".to_vec(),
        b"[1,2]".to_vec(),
        b"".to_vec(),
        b"null".to_vec(),
        too_big,
    ] {
        let dir = vault_with(&corrupt);
        let refused = |error: ConfigError| matches!(error, ConfigError::Unreadable { .. });
        assert!(refused(
            merge_preferences(dir.path(), &general, &none()).unwrap_err()
        ));
        assert!(refused(
            write_vault_icon(dir.path(), |_| json!({"updatedAt": 1})).unwrap_err()
        ));
        assert!(refused(
            write_vault_config(
                dir.path(),
                &VaultConfigPatch {
                    journal_folder: Some("x".into()),
                    ..Default::default()
                }
            )
            .unwrap_err()
        ));
        assert_eq!(bytes(dir.path()), corrupt, "the file is untouched");
        assert!(!has_stored_preferences(dir.path()));
        assert_eq!(read_vault_config(dir.path()), VaultConfig::default());
    }
}

#[test]
fn a_write_keeps_every_other_key_in_value_and_order() {
    let dir = vault_with(ELECTRON.as_bytes());
    merge_preferences(
        dir.path(),
        &object(json!({"theme": "light", "notPortable": 1})),
        &object(json!({"width": "full"})),
    )
    .unwrap();
    let after: Value = serde_json::from_slice(&bytes(dir.path())).unwrap();
    let before: Value = serde_json::from_str(ELECTRON).unwrap();
    assert_eq!(
        after.as_object().unwrap().keys().collect::<Vec<_>>(),
        before.as_object().unwrap().keys().collect::<Vec<_>>()
    );
    for key in [
        "excludePatterns",
        "journalFolder",
        "vaultIcon",
        "newerBuild",
    ] {
        assert_eq!(after[key], before[key], "{key}");
    }
    let prefs = &after["preferences"];
    assert_eq!(prefs["theme"], "light");
    assert_eq!(prefs["future"], before["preferences"]["future"]);
    assert_eq!(prefs["editor"], json!({"width": "full", "x": 1}));
    assert!(prefs.get("notPortable").is_none());

    write_vault_config(
        dir.path(),
        &VaultConfigPatch {
            journal_show_in_sidebar: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let after: Value = serde_json::from_slice(&bytes(dir.path())).unwrap();
    assert_eq!(after["journalShowInSidebar"], false);
    assert_eq!(after["preferences"]["theme"], "light");
    assert_eq!(after["newerBuild"], json!([1, 2]));
}

#[test]
fn a_vault_with_no_config_has_nothing_stored_and_a_first_write_creates_the_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    assert!(!has_stored_preferences(dir.path()));
    assert!(read_preferences(dir.path(), &none(), &none()).is_none());
    assert_eq!(read_vault_config(dir.path()), VaultConfig::default());
    merge_preferences(dir.path(), &object(json!({"language": "de"})), &none()).unwrap();
    assert_eq!(preferences_language(dir.path()).as_deref(), Some("de"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(config_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[cfg(unix)]
#[test]
fn a_write_keeps_the_mode_of_the_file_it_replaces() {
    use std::os::unix::fs::PermissionsExt;
    let dir = vault_with(ELECTRON.as_bytes());
    fs::set_permissions(config_path(dir.path()), fs::Permissions::from_mode(0o640)).unwrap();
    merge_preferences(dir.path(), &object(json!({"theme": "light"})), &none()).unwrap();
    let mode = fs::metadata(config_path(dir.path()))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o640);
}

#[test]
fn reads_default_field_by_field_and_never_fail() {
    let dir = vault_with(
        br#"{"journalFolder": 5, "excludePatterns": ["a", 3, "b"], "defaultNoteFolder": "n",
             "journalShowInSidebar": "yes"}"#,
    );
    let config = read_vault_config(dir.path());
    assert_eq!(
        config.journal_folder, "journal",
        "a wrong type is the default"
    );
    assert_eq!(config.exclude_patterns, ["a", "b"]);
    assert_eq!(config.default_note_folder, "n");
    assert!(!config.journal_show_in_sidebar);
}

#[test]
fn the_cache_follows_the_file_whoever_changes_it() {
    let dir = vault_with(br#"{"journalFolder": "one"}"#);
    assert_eq!(read_vault_config(dir.path()).journal_folder, "one");
    // An outside writer (an Electron build on the same vault) changes the size.
    fs::write(config_path(dir.path()), br#"{"journalFolder": "three"}"#).unwrap();
    assert_eq!(read_vault_config(dir.path()).journal_folder, "three");
    // Our own write is visible at once.
    write_vault_config(
        dir.path(),
        &VaultConfigPatch {
            journal_folder: Some("own".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(read_vault_config(dir.path()).journal_folder, "own");
    fs::remove_file(config_path(dir.path())).unwrap();
    assert_eq!(read_vault_config(dir.path()), VaultConfig::default());
    invalidate_vault_config_cache();
}

#[test]
fn concurrent_writers_do_not_lose_each_others_keys() {
    let dir = vault_with(b"{}");
    let path = dir.path().to_path_buf();
    let threads: Vec<_> = (0..8)
        .map(|n| {
            let path = path.clone();
            std::thread::spawn(move || {
                for round in 0..10 {
                    if n % 2 == 0 {
                        merge_preferences(
                            &path,
                            &object(json!({"fontSizePx": 14 + round})),
                            &none(),
                        )
                        .unwrap();
                    } else {
                        write_vault_icon(&path, |_| json!({"updatedAt": round})).unwrap();
                    }
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert!(read_vault_icon(&path).is_some());
    assert!(has_stored_preferences(&path));
}

#[cfg(unix)]
#[test]
fn a_config_that_is_a_pipe_or_a_link_out_of_the_vault_is_refused_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("v");
    fs::create_dir_all(vault.join(".memry")).unwrap();
    let outside = dir.path().join("outside.json");
    fs::write(&outside, ELECTRON).unwrap();
    std::os::unix::fs::symlink(&outside, config_path(&vault)).unwrap();
    assert!(matches!(
        merge_preferences(&vault, &object(json!({"theme": "light"})), &none()),
        Err(ConfigError::Unreadable { .. })
    ));
    assert_eq!(fs::read_to_string(&outside).unwrap(), ELECTRON);
    assert_eq!(read_vault_config(&vault), VaultConfig::default());

    fs::remove_file(config_path(&vault)).unwrap();
    let made = std::process::Command::new("mkfifo")
        .arg(config_path(&vault))
        .status()
        .unwrap();
    assert!(made.success());
    assert_eq!(read_vault_config(&vault), VaultConfig::default());
    assert!(merge_preferences(&vault, &object(json!({"theme": "light"})), &none()).is_err());
}

#[test]
fn a_deeply_nested_config_is_an_error_not_a_stack_overflow() {
    let depth = 200_000;
    let hostile = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let dir = vault_with(format!("{{\"a\":{hostile}}}").as_bytes());
    let path = dir.path().to_path_buf();
    // A small stack makes a recursion bug fail here and not only in a bigger process.
    let result = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let read = read_vault_config(&path);
            let write = merge_preferences(&path, &object(json!({"theme": "dark"})), &Map::new());
            (read, write.is_err())
        })
        .unwrap()
        .join()
        .expect("no stack overflow");
    assert_eq!(result.0, VaultConfig::default());
    assert!(result.1);
}

#[cfg(unix)]
#[test]
fn a_config_linked_inside_the_vault_is_written_through_the_link() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    let real = dir.path().join("shared-config.json");
    fs::write(&real, ELECTRON).unwrap();
    std::os::unix::fs::symlink(&real, config_path(dir.path())).unwrap();
    merge_preferences(dir.path(), &object(json!({"theme": "light"})), &none()).unwrap();
    assert!(
        fs::symlink_metadata(config_path(dir.path()))
            .unwrap()
            .is_symlink()
    );
    let after: Value = serde_json::from_slice(&fs::read(&real).unwrap()).unwrap();
    assert_eq!(after["preferences"]["theme"], "light");
    assert_eq!(after["newerBuild"], json!([1, 2]));
}
