//! `.memry/config.json` as Electron's writers leave it (`fixtures/electron-vault/config-json.json`,
//! produced by `fixtures/gen-config-vectors.mjs` from `initVault`, `writeVaultConfig`,
//! `writePreferences` and `writeVaultIcon`), through this build's readers and writers. A vault
//! opened by both builds, or by Electron after the cutover's rollback, must mean the same thing
//! to each: the same settings read from every file either wrote, and no key one wrote lost by
//! the other.
//!
//! This build's writers change only what they name (`vault::config`), where Electron rewrote
//! every field it knows; so its write of a change is checked by what it reads back, against
//! what Electron read back from its own write of that change.

use std::fs;
use std::path::Path;

use memry_desktop::vault::config::{
    PORTABLE_EDITOR, PORTABLE_GENERAL, VaultConfig, VaultConfigPatch, config_path,
    has_stored_preferences, invalidate_vault_config_cache, merge_preferences, read_preferences,
    read_vault_config, write_vault_config, write_vault_icon,
};
use memry_desktop::vault::init::init_vault;
use serde_json::{Map, Value, json};

/// `DEFAULT_CONFIG`'s keys in its order: the order `writeVaultConfig` writes them in.
const CONFIG_KEYS: [&str; 6] = [
    "excludePatterns",
    "defaultNoteFolder",
    "journalFolder",
    "journalDateFormat",
    "attachmentsFolder",
    "journalShowInSidebar",
];

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/electron-vault/config-json.json")).unwrap()
}

/// Every step of every case, with the file Electron had before it (`None` for no file).
fn steps(vectors: &Value) -> Vec<(String, Option<String>, Value)> {
    let mut all = Vec::new();
    for case in vectors["cases"].as_array().unwrap() {
        let mut before = case["start"].as_str().map(str::to_owned);
        for (n, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{} step {n} ({})", case["name"], step["kind"]);
            all.push((label, before.clone(), step.clone()));
            before = Some(step["file"].as_str().unwrap().to_owned());
        }
    }
    all
}

fn vault_with(file: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".memry")).unwrap();
    if let Some(file) = file {
        fs::write(config_path(dir.path()), file).unwrap();
    }
    invalidate_vault_config_cache();
    dir
}

fn on_disk(vault: &Path) -> String {
    fs::read_to_string(config_path(vault)).unwrap()
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn texts(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

fn config_of(read: &Value) -> VaultConfig {
    let text = |key: &str| read[key].as_str().unwrap().to_owned();
    VaultConfig {
        exclude_patterns: texts(&read["excludePatterns"]),
        default_note_folder: text("defaultNoteFolder"),
        journal_folder: text("journalFolder"),
        journal_date_format: text("journalDateFormat"),
        attachments_folder: text("attachmentsFolder"),
        journal_show_in_sidebar: read["journalShowInSidebar"].as_bool().unwrap(),
    }
}

/// Asserts this build reads the vault as Electron read the file it wrote: `read` is what
/// Electron's readers returned.
fn assert_reads_as(vault: &Path, read: &Value, defaults: &Value, label: &str) {
    invalidate_vault_config_cache();
    assert_eq!(
        read_vault_config(vault),
        config_of(&read["config"]),
        "{label}"
    );
    let stored = read["hasStoredPreferences"].as_bool().unwrap();
    assert_eq!(has_stored_preferences(vault), stored, "{label}");
    let mut general_defaults = object(defaults);
    general_defaults.remove("editor");
    let ours = read_preferences(vault, &general_defaults, &object(&defaults["editor"]));
    if !stored {
        assert!(ours.is_none(), "{label}");
        return;
    }
    let (general, editor) = ours.expect(label);
    let electron = &read["preferences"];
    for field in PORTABLE_GENERAL {
        assert_eq!(general[field], electron[field], "{label}: {field}");
    }
    for field in PORTABLE_EDITOR {
        let mut expected = electron["editor"][field].clone();
        // This build coerces a legacy width (narrow, medium, wide) where Electron read it;
        // Electron's settings schema coerces it the same way before anything uses it.
        if field == "width" && expected != "full" {
            expected = json!("normal");
        }
        assert_eq!(editor[field], expected, "{label}: editor.{field}");
    }
}

fn patch_of(arg: &Value) -> VaultConfigPatch {
    let text = |key: &str| arg.get(key).and_then(Value::as_str).map(str::to_owned);
    VaultConfigPatch {
        exclude_patterns: arg.get("excludePatterns").map(texts),
        default_note_folder: text("defaultNoteFolder"),
        journal_folder: text("journalFolder"),
        journal_date_format: text("journalDateFormat"),
        attachments_folder: text("attachmentsFolder"),
        journal_show_in_sidebar: arg.get("journalShowInSidebar").and_then(Value::as_bool),
    }
}

/// This build's writer of the change Electron's step made.
fn write_as_this_build(vault: &Path, kind: &str, arg: &Value) {
    match kind {
        "init" => init_vault(vault).unwrap(),
        "config" => {
            write_vault_config(vault, &patch_of(arg)).unwrap();
        }
        "preferences" => {
            let mut general = object(arg);
            let editor = general
                .remove("editor")
                .map(|e| object(&e))
                .unwrap_or_default();
            merge_preferences(vault, &general, &editor).unwrap();
        }
        "icon" => write_vault_icon(vault, |_| arg.clone()).unwrap(),
        other => panic!("no writer for {other}"),
    }
}

#[test]
fn a_new_vault_gets_the_bytes_electron_writes() {
    let vectors = vectors();
    let init = &vectors["cases"][0]["steps"][0];
    assert_eq!(init["kind"], "init");
    let dir = vault_with(None);
    fs::remove_dir(dir.path().join(".memry")).unwrap();
    init_vault(dir.path()).unwrap();
    assert_eq!(on_disk(dir.path()), init["file"].as_str().unwrap());
}

#[test]
fn every_file_electron_wrote_reads_as_electron_reads_it() {
    let vectors = vectors();
    for (label, _, step) in steps(&vectors) {
        let dir = vault_with(step["file"].as_str());
        assert_reads_as(
            dir.path(),
            &step["read"],
            &vectors["preferenceDefaults"],
            &label,
        );
    }
}

/// The same change made by this build to the file Electron had before it reads back as
/// Electron's write of it did.
#[test]
fn this_builds_write_of_each_change_reads_as_electrons() {
    let vectors = vectors();
    for (label, before, step) in steps(&vectors) {
        let dir = vault_with(before.as_deref());
        let kind = step["kind"].as_str().unwrap();
        if kind == "init" {
            fs::remove_dir(dir.path().join(".memry")).unwrap();
        }
        write_as_this_build(dir.path(), kind, &step["arg"]);
        assert_reads_as(
            dir.path(),
            &step["read"],
            &vectors["preferenceDefaults"],
            &label,
        );
    }
}

/// Electron's config and icon writers spread the file and set their keys; this build's do the
/// same, so from a file in Electron's key order their bytes are Electron's.
#[test]
fn a_config_or_icon_write_makes_electrons_bytes() {
    let vectors = vectors();
    let mut compared = 0;
    for (label, before, step) in steps(&vectors) {
        let kind = step["kind"].as_str().unwrap();
        let in_electron_order = before.as_deref().is_some_and(|file| {
            let keys: Vec<String> = object(&serde_json::from_str(file).unwrap())
                .keys()
                .cloned()
                .collect();
            keys.starts_with(&CONFIG_KEYS.map(str::to_owned))
        });
        if !matches!(kind, "config" | "icon") || !in_electron_order {
            continue;
        }
        let dir = vault_with(before.as_deref());
        write_as_this_build(dir.path(), kind, &step["arg"]);
        assert_eq!(
            on_disk(dir.path()),
            step["file"].as_str().unwrap(),
            "{label}"
        );
        compared += 1;
    }
    assert!(compared >= 4, "only {compared} writes compared");
}

/// A writer of this build: the top-level key it names, and the `preferences` keys it names.
type Writer = (&'static str, &'static [&'static str], fn(&Path));

/// `legacyColorTheme` of the file before a theme write, which both builds persist with it.
fn derived_color_theme(old: &Map<String, Value>) -> Value {
    match old.get("theme").and_then(Value::as_str) {
        Some("light" | "system") => json!("warm"),
        _ => json!("memrynote"),
    }
}

/// Every key Electron wrote that a writer does not name stays, in value and in order: top-level
/// keys, `preferences` keys and `editor` keys a newer build added included. A theme write adds
/// one key it does not name, `colorTheme`, and only where the file had none (or `null`).
#[test]
fn this_builds_writers_keep_every_other_key_electron_wrote() {
    let vectors = vectors();
    for (label, _, step) in steps(&vectors) {
        let file = step["file"].as_str().unwrap();
        let before = object(&serde_json::from_str(file).unwrap());
        let writes: [Writer; 4] = [
            ("journalFolder", &[], |v| {
                write_vault_config(
                    v,
                    &VaultConfigPatch {
                        journal_folder: Some("moved".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }),
            ("vaultIcon", &[], |v| {
                write_vault_icon(v, |_| json!({"updatedAt": 99})).unwrap()
            }),
            ("preferences", &["minimizeToTray"], |v| {
                merge_preferences(
                    v,
                    &object(&json!({"minimizeToTray": true})),
                    &object(&json!({"pdfDisplayMode": "link"})),
                )
                .unwrap();
            }),
            ("preferences", &["theme"], |v| {
                merge_preferences(v, &object(&json!({"theme": "dark"})), &Map::new()).unwrap();
            }),
        ];
        for (named, prefs_named, write) in writes {
            let dir = vault_with(Some(file));
            write(dir.path());
            let after = object(&serde_json::from_str(&on_disk(dir.path())).unwrap());
            let kept = |map: &Map<String, Value>| -> Vec<(String, Value)> {
                map.iter()
                    .filter(|(k, _)| k.as_str() != named)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            };
            assert_eq!(kept(&after), kept(&before), "{label}: {named}");
            if named != "preferences" {
                continue;
            }
            let old = before.get("preferences").map(object).unwrap_or_default();
            let new = object(&after["preferences"]);
            let derives =
                prefs_named.contains(&"theme") && old.get("colorTheme").is_none_or(Value::is_null);
            for (key, value) in &old {
                let named = prefs_named.contains(&key.as_str());
                if !named && key != "editor" && !(derives && key == "colorTheme") {
                    assert_eq!(&new[key], value, "{label}: preferences.{key}");
                }
            }
            for key in new.keys() {
                let named = prefs_named.contains(&key.as_str());
                assert!(
                    old.contains_key(key)
                        || named
                        || key == "editor"
                        || derives && key == "colorTheme",
                    "{label}: {prefs_named:?} added preferences.{key}"
                );
            }
            if derives {
                assert_eq!(new["colorTheme"], derived_color_theme(&old), "{label}");
            }
            if let Some(editor) = old.get("editor") {
                for (key, value) in object(editor) {
                    if key != "pdfDisplayMode" {
                        assert_eq!(new["editor"][&key], value, "{label}: editor.{key}");
                    }
                }
            }
        }
    }
}

/// `fixtures/electron-vault/config-json-ours.json`: the file this build writes for each step,
/// and what Electron's readers make of it. Regenerate it in two steps, from `crates/`:
/// `MEMRY_UPDATE_CONFIG_VECTORS=1 cargo test -p memry-desktop --test config_compat`, then the
/// generator (`gen-config-vectors.mjs`), which adds Electron's reads.
const OURS: &str = "tests/fixtures/electron-vault/config-json-ours.json";

/// A vault written by this build and then opened by Electron (a rollback, or a second device on
/// an older build) means to Electron what Electron's own write of the change meant.
#[test]
fn electron_reads_this_builds_write_of_each_change_as_its_own() {
    let vectors = vectors();
    let mut written = Vec::new();
    for (label, before, step) in steps(&vectors) {
        let dir = vault_with(before.as_deref());
        let kind = step["kind"].as_str().unwrap();
        if kind == "init" {
            fs::remove_dir(dir.path().join(".memry")).unwrap();
        }
        write_as_this_build(dir.path(), kind, &step["arg"]);
        written.push((label, on_disk(dir.path()), step["read"].clone()));
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(OURS);
    if std::env::var_os("MEMRY_UPDATE_CONFIG_VECTORS").is_some() {
        let steps: Vec<Value> = written
            .iter()
            .map(|(label, file, _)| json!({"label": label, "file": file, "read": null}))
            .collect();
        let text = serde_json::to_string_pretty(&json!({ "steps": steps })).unwrap();
        fs::write(&path, text + "\n").unwrap();
        return;
    }
    let ours: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let recorded = ours["steps"].as_array().unwrap();
    assert_eq!(recorded.len(), written.len(), "{OURS} is stale");
    for ((label, file, electron_read), recorded) in written.iter().zip(recorded) {
        assert_eq!(recorded["label"], json!(label), "{OURS} is stale");
        assert_eq!(recorded["file"], json!(file), "{label}: {OURS} is stale");
        assert_eq!(&recorded["read"], electron_read, "{label}");
    }
}
