//! Per-vault JSON config + UI preferences.
//!
//! Layout matches Electron's vault format:
//!
//! ```text
//! <vault>/
//! ├── .memry/
//! │   └── config.json
//! ├── notes/
//! ├── journal/
//! └── attachments/
//!     ├── images/
//!     └── files/
//! ```
//!
//! The config file is small and updated by explicit user actions, so this
//! module deliberately uses synchronous JSON IO.

use crate::error::{AppError, AppResult};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MEMRY_DIR: &str = ".memry";
const CONFIG_FILE: &str = "config.json";

const VAULT_FOLDERS: &[&str] = &[
    "notes",
    "journal",
    "attachments",
    "attachments/images",
    "attachments/files",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub exclude_patterns: Vec<String>,
    pub default_note_folder: String,
    pub journal_folder: String,
    pub attachments_folder: String,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            exclude_patterns: vec![".git".into(), "node_modules".into(), ".trash".into()],
            default_note_folder: "notes".into(),
            journal_folder: "journal".into(),
            attachments_folder: "attachments".into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreferences {
    pub width: String,
    pub spell_check: bool,
    pub auto_save_delay: u32,
    pub show_word_count: bool,
    pub toolbar_mode: String,
}

impl Default for EditorPreferences {
    fn default() -> Self {
        Self {
            width: "medium".into(),
            spell_check: true,
            auto_save_delay: 1000,
            show_word_count: true,
            toolbar_mode: "floating".into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPreferences {
    pub theme: String,
    pub font_size: String,
    pub font_family: String,
    pub accent_color: String,
    pub language: String,
    pub create_in_selected_folder: bool,
    pub editor: EditorPreferences,
}

impl Default for VaultPreferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            font_size: "medium".into(),
            font_family: "system".into(),
            accent_color: "#2563eb".into(),
            language: "en".into(),
            create_in_selected_folder: true,
            editor: EditorPreferences::default(),
        }
    }
}

pub fn memry_dir(vault_path: &Path) -> PathBuf {
    vault_path.join(MEMRY_DIR)
}

pub fn config_path(vault_path: &Path) -> PathBuf {
    memry_dir(vault_path).join(CONFIG_FILE)
}

pub fn is_initialized(vault_path: &Path) -> bool {
    memry_dir(vault_path).exists()
}

pub fn init_vault(vault_path: &Path) -> AppResult<()> {
    fs::create_dir_all(memry_dir(vault_path))?;
    for folder in VAULT_FOLDERS {
        fs::create_dir_all(vault_path.join(folder))?;
    }

    let cfg_path = config_path(vault_path);
    if !cfg_path.exists() {
        write_json_atomic(&cfg_path, &build_initial_config_blob())?;
    }

    Ok(())
}

pub fn read_config(vault_path: &Path) -> AppResult<VaultConfig> {
    let blob = read_config_blob(vault_path)?;
    let defaults = VaultConfig::default();

    Ok(VaultConfig {
        exclude_patterns: blob
            .get("excludePatterns")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or(defaults.exclude_patterns),
        default_note_folder: blob
            .get("defaultNoteFolder")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or(defaults.default_note_folder),
        journal_folder: blob
            .get("journalFolder")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or(defaults.journal_folder),
        attachments_folder: blob
            .get("attachmentsFolder")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or(defaults.attachments_folder),
    })
}

pub fn update_config(vault_path: &Path, updates: &VaultConfig) -> AppResult<VaultConfig> {
    let mut blob = read_config_blob(vault_path)?;
    let obj = ensure_object(&mut blob);

    obj.insert(
        "excludePatterns".into(),
        serde_json::to_value(&updates.exclude_patterns)?,
    );
    obj.insert(
        "defaultNoteFolder".into(),
        Value::String(updates.default_note_folder.clone()),
    );
    obj.insert(
        "journalFolder".into(),
        Value::String(updates.journal_folder.clone()),
    );
    obj.insert(
        "attachmentsFolder".into(),
        Value::String(updates.attachments_folder.clone()),
    );

    write_json_atomic(&config_path(vault_path), &blob)?;
    Ok(updates.clone())
}

pub fn read_preferences(vault_path: &Path) -> AppResult<VaultPreferences> {
    let blob = read_config_blob(vault_path)?;
    let prefs = blob
        .get("preferences")
        .cloned()
        .unwrap_or_else(default_preferences_value);

    Ok(serde_json::from_value(prefs).unwrap_or_else(|_| VaultPreferences::default()))
}

pub fn update_preferences(
    vault_path: &Path,
    partial: &Map<String, Value>,
) -> AppResult<VaultPreferences> {
    let mut blob = read_config_blob(vault_path)?;

    let mut prefs = blob
        .get("preferences")
        .cloned()
        .unwrap_or_else(default_preferences_value);
    if !prefs.is_object() {
        prefs = default_preferences_value();
    }

    let prefs_obj = ensure_object(&mut prefs);
    for (key, value) in partial {
        prefs_obj.insert(key.clone(), value.clone());
    }

    let merged: VaultPreferences = serde_json::from_value(prefs.clone())?;
    let config_obj = ensure_object(&mut blob);
    config_obj.insert("preferences".into(), prefs);
    write_json_atomic(&config_path(vault_path), &blob)?;

    Ok(merged)
}

pub fn vault_name(vault_path: &Path) -> String {
    vault_path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("vault")
        .to_string()
}

pub fn count_markdown_files(vault_path: &Path, exclude_patterns: &[String]) -> i64 {
    let mut count = 0;
    let mut stack = vec![vault_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || exclude_patterns.iter().any(|pattern| pattern == &*name) {
                continue;
            }

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() && crate::vault::paths::is_markdown(&path) {
                count += 1;
            }
        }
    }

    count
}

fn read_config_blob(vault_path: &Path) -> AppResult<Value> {
    let path = config_path(vault_path);
    if !path.exists() {
        return Ok(build_initial_config_blob());
    }

    let raw = fs::read_to_string(path)?;
    let parsed = serde_json::from_str(&raw).unwrap_or_else(|_| build_initial_config_blob());
    Ok(parsed)
}

fn write_json_atomic(path: &Path, value: &Value) -> AppResult<()> {
    let serialized = serde_json::to_string_pretty(value)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Vault(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;

    let temp_path = parent.join(format!(".tmp.{}", nanoid::nanoid!(12)));
    let result = (|| -> AppResult<()> {
        fs::write(&temp_path, serialized)?;
        fs::rename(&temp_path, path)?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    Ok(())
}

fn build_initial_config_blob() -> Value {
    let defaults = VaultConfig::default();
    let mut obj = Map::new();
    obj.insert(
        "excludePatterns".into(),
        Value::Array(
            defaults
                .exclude_patterns
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    obj.insert(
        "defaultNoteFolder".into(),
        Value::String(defaults.default_note_folder),
    );
    obj.insert(
        "journalFolder".into(),
        Value::String(defaults.journal_folder),
    );
    obj.insert(
        "attachmentsFolder".into(),
        Value::String(defaults.attachments_folder),
    );
    obj.insert("preferences".into(), default_preferences_value());
    Value::Object(obj)
}

fn default_preferences_value() -> Value {
    let defaults = VaultPreferences::default();
    let editor = defaults.editor;

    let mut editor_obj = Map::new();
    editor_obj.insert("width".into(), Value::String(editor.width));
    editor_obj.insert("spellCheck".into(), Value::Bool(editor.spell_check));
    editor_obj.insert(
        "autoSaveDelay".into(),
        Value::Number(serde_json::Number::from(editor.auto_save_delay)),
    );
    editor_obj.insert("showWordCount".into(), Value::Bool(editor.show_word_count));
    editor_obj.insert("toolbarMode".into(), Value::String(editor.toolbar_mode));

    let mut prefs_obj = Map::new();
    prefs_obj.insert("theme".into(), Value::String(defaults.theme));
    prefs_obj.insert("fontSize".into(), Value::String(defaults.font_size));
    prefs_obj.insert("fontFamily".into(), Value::String(defaults.font_family));
    prefs_obj.insert("accentColor".into(), Value::String(defaults.accent_color));
    prefs_obj.insert("language".into(), Value::String(defaults.language));
    prefs_obj.insert(
        "createInSelectedFolder".into(),
        Value::Bool(defaults.create_in_selected_folder),
    );
    prefs_obj.insert("editor".into(), Value::Object(editor_obj));
    Value::Object(prefs_obj)
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    match value {
        Value::Object(obj) => obj,
        _ => unreachable!("value was normalized to a JSON object"),
    }
}
