use memry_desktop_tauri_lib::vault::preferences::{self, VaultConfig};

fn make_vault() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn init_creates_dot_memry_with_default_config() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();

    assert!(vault.path().join(".memry").exists());
    assert!(vault.path().join("notes").exists());
    assert!(vault.path().join("journal").exists());
    assert!(vault.path().join("attachments").exists());
    assert!(vault.path().join("attachments/images").exists());
    assert!(vault.path().join("attachments/files").exists());
    assert!(vault.path().join(".memry/config.json").exists());

    let raw = std::fs::read_to_string(vault.path().join(".memry/config.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["defaultNoteFolder"], "notes");
    assert_eq!(json["preferences"]["fontSize"], "medium");
}

#[test]
fn init_is_idempotent() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    preferences::init_vault(vault.path()).unwrap();
}

#[test]
fn read_config_returns_defaults_when_missing() {
    let vault = make_vault();
    let cfg = preferences::read_config(vault.path()).unwrap();
    assert_eq!(cfg.default_note_folder, "notes");
    assert_eq!(cfg.journal_folder, "journal");
    assert_eq!(cfg.attachments_folder, "attachments");
    assert!(cfg.exclude_patterns.contains(&".git".to_string()));
}

#[test]
fn write_config_round_trips() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    let updated = preferences::update_config(
        vault.path(),
        &VaultConfig {
            exclude_patterns: vec!["custom".into(), "node_modules".into()],
            default_note_folder: "Notes".into(),
            journal_folder: "Daily".into(),
            attachments_folder: "files".into(),
        },
    )
    .unwrap();

    let read = preferences::read_config(vault.path()).unwrap();
    assert_eq!(read.default_note_folder, "Notes");
    assert_eq!(read.journal_folder, "Daily");
    assert_eq!(read.attachments_folder, "files");
    assert_eq!(updated.exclude_patterns, read.exclude_patterns);
}

#[test]
fn read_preferences_returns_defaults_when_missing() {
    let vault = make_vault();
    let prefs = preferences::read_preferences(vault.path()).unwrap();
    assert_eq!(prefs.theme, "system");
    assert_eq!(prefs.font_size, "medium");
    assert_eq!(prefs.editor.toolbar_mode, "floating");
}

#[test]
fn update_preferences_merges_partial() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();

    let mut updates = serde_json::Map::new();
    updates.insert("theme".into(), serde_json::Value::String("dark".into()));
    let merged = preferences::update_preferences(vault.path(), &updates).unwrap();

    assert_eq!(merged.theme, "dark");
    assert_eq!(merged.font_size, "medium");
}

#[test]
fn vault_name_falls_back_to_basename() {
    let dir = tempfile::tempdir().unwrap();
    let vault_path = dir.path().join("Personal Vault");
    std::fs::create_dir_all(&vault_path).unwrap();

    assert_eq!(preferences::vault_name(&vault_path), "Personal Vault");
}

#[test]
fn count_markdown_files_excludes_patterns_and_hidden() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    std::fs::write(vault.path().join("notes/a.md"), "x").unwrap();
    std::fs::write(vault.path().join("notes/b.markdown"), "x").unwrap();
    std::fs::create_dir_all(vault.path().join("node_modules")).unwrap();
    std::fs::write(vault.path().join("node_modules/c.md"), "x").unwrap();
    std::fs::create_dir_all(vault.path().join(".hidden-dir")).unwrap();
    std::fs::write(vault.path().join(".hidden-dir/d.md"), "x").unwrap();
    std::fs::write(vault.path().join("notes/.hidden.md"), "x").unwrap();
    std::fs::write(vault.path().join("notes/not-markdown.txt"), "x").unwrap();

    let count = preferences::count_markdown_files(
        vault.path(),
        &["node_modules".to_string(), ".git".to_string()],
    );
    assert_eq!(count, 2);
}
