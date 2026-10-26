//! Vault-portable preferences: the `preferences` object of `<vault>/.memry/config.json`, the
//! theme, fonts, language and editor choices that travel with the vault folder
//! (`apps/desktop/src/main/vault/vault-preferences.ts`).
//!
//! Reads are tolerant on purpose: the file is written by older and newer builds, so an
//! unrecognised value degrades to the default and an unknown key survives a write. This module
//! touches only the `preferences` object; every other key of `config.json` (Step 12 owns the
//! file) is preserved as parsed.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// General fields that live in the vault file, in `PORTABLE_GENERAL_FIELDS` order.
pub const PORTABLE_GENERAL: [&str; 16] = [
    "theme",
    "fontSize",
    "fontSizePx",
    "fontFamily",
    "customFontFamily",
    "accentColor",
    "colorTheme",
    "useThemeAccent",
    "backgroundLight",
    "foregroundLight",
    "backgroundDark",
    "foregroundDark",
    "language",
    "createInSelectedFolder",
    "openPagesInNewTab",
    "minimizeToTray",
];

/// Editor fields that live in the vault file (`editor.*` of the preferences).
pub const PORTABLE_EDITOR: [&str; 7] = [
    "width",
    "toolbarMode",
    "spellCheck",
    "pdfAdaptToTheme",
    "pdfDisplayMode",
    "convertChecklistsToTasks",
    "convertAgentChecklistsToTasks",
];

pub fn config_path(vault: &Path) -> PathBuf {
    vault.join(".memry").join("config.json")
}

fn read_config(vault: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_slice(&fs::read(config_path(vault)).ok()?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Whether `config.json` already carries a `preferences` object. This, not the values, is the
/// marker that the vault's settings have been written once.
pub fn has_stored(vault: &Path) -> bool {
    read_config(vault).is_some_and(|c| c.get("preferences").is_some_and(|p| !p.is_null()))
}

/// `legacyColorTheme`: a config from before color themes picked warm or white by the mode.
fn legacy_color_theme(theme: Option<&Value>) -> &'static str {
    match theme.and_then(Value::as_str) {
        Some("light" | "system") => "warm",
        _ => "memrynote",
    }
}

/// `resolveFontSizePx`: the legacy bucket supplies the pixel size when it is missing or when
/// the pair disagrees (an older build changed only the bucket).
fn font_size_px(px: Option<&Value>, bucket: Option<&Value>) -> i64 {
    let legacy = match bucket.and_then(Value::as_str) {
        Some("small") => Some(14),
        Some("medium") => Some(16),
        Some("large") => Some(20),
        _ => None,
    };
    if let Some(px) = px.and_then(Value::as_f64).filter(|n| n.is_finite()) {
        let px = px.clamp(12.0, 24.0).round() as i64;
        let bucket_of = match px {
            ..=14 => 14,
            15..=17 => 16,
            _ => 20,
        };
        if legacy.is_none_or(|l| l == bucket_of) {
            return px;
        }
    }
    legacy.unwrap_or(16)
}

/// The portable general and editor values of a vault, defaults filled in for what is missing
/// and legacy values coerced. `None` when the vault has no stored preferences.
pub fn read(
    vault: &Path,
    defaults_general: &Map<String, Value>,
    defaults_editor: &Map<String, Value>,
) -> Option<(Map<String, Value>, Map<String, Value>)> {
    let config = read_config(vault)?;
    let prefs = config.get("preferences")?.as_object()?;
    let mut general = Map::new();
    for field in PORTABLE_GENERAL {
        let value = match field {
            "fontSizePx" => Some(json!(font_size_px(
                prefs.get("fontSizePx"),
                prefs.get("fontSize")
            ))),
            "colorTheme" => prefs
                .get(field)
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| Some(json!(legacy_color_theme(prefs.get("theme"))))),
            _ => prefs.get(field).filter(|v| !v.is_null()).cloned(),
        };
        if let Some(value) = value.or_else(|| defaults_general.get(field).cloned()) {
            general.insert(field.to_owned(), value);
        }
    }
    let stored_editor = prefs.get("editor").and_then(Value::as_object);
    let mut editor = Map::new();
    for field in PORTABLE_EDITOR {
        let mut value = stored_editor
            .and_then(|e| e.get(field))
            .filter(|v| !v.is_null())
            .cloned();
        // Legacy widths (narrow, medium, wide) coerce to `normal`.
        if field == "width"
            && let Some(width) = &value
        {
            value = Some(if width == "full" {
                json!("full")
            } else {
                json!("normal")
            });
        }
        if let Some(value) = value.or_else(|| defaults_editor.get(field).cloned()) {
            editor.insert(field.to_owned(), value);
        }
    }
    Some((general, editor))
}

/// Merges portable `general` and `editor` fields into `preferences` (read, merge, write to a
/// sibling, rename). Fields the vault file already has and the patch does not name stay as
/// written, including unknown ones.
pub fn write(
    vault: &Path,
    general: &Map<String, Value>,
    editor: &Map<String, Value>,
) -> std::io::Result<()> {
    if general.is_empty() && editor.is_empty() {
        return Ok(());
    }
    let path = config_path(vault);
    let mut config = read_config(vault).unwrap_or_default();
    let mut prefs = match config.remove("preferences") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (field, value) in general {
        if PORTABLE_GENERAL.contains(&field.as_str()) {
            prefs.insert(field.clone(), value.clone());
        }
    }
    if editor.keys().any(|f| PORTABLE_EDITOR.contains(&f.as_str())) {
        let mut stored = match prefs.remove("editor") {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        for (field, value) in editor {
            if PORTABLE_EDITOR.contains(&field.as_str()) {
                stored.insert(field.clone(), value.clone());
            }
        }
        prefs.insert("editor".to_owned(), Value::Object(stored));
    }
    config.insert("preferences".to_owned(), Value::Object(prefs));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(serde_json::to_string_pretty(&Value::Object(config))?.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// The vault's language preference, when it is a string.
pub fn language(vault: &Path) -> Option<String> {
    read_config(vault)?
        .get("preferences")?
        .get("language")?
        .as_str()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(json_text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tmp");
        fs::create_dir_all(dir.path().join(".memry")).expect("mkdir");
        fs::write(config_path(dir.path()), json_text).expect("seed");
        dir
    }

    fn none() -> Map<String, Value> {
        Map::new()
    }

    #[test]
    fn legacy_values_coerce_and_a_missing_font_px_comes_from_the_bucket() {
        let dir = seeded(
            r#"{"preferences":{"theme":"light","fontSize":"large","editor":{"width":"wide"}}}"#,
        );
        let (general, editor) = read(dir.path(), &none(), &none()).expect("stored");
        assert_eq!(general["fontSizePx"], 20);
        assert_eq!(general["colorTheme"], "warm");
        assert_eq!(editor["width"], "normal");
        let dir = seeded(r#"{"preferences":{"fontSizePx":13,"fontSize":"large"}}"#);
        assert_eq!(
            read(dir.path(), &none(), &none()).expect("stored").0["fontSizePx"],
            20,
            "an incoherent pair follows the bucket"
        );
        let dir = seeded(r#"{"preferences":{"fontSizePx":16.4,"fontSize":"medium"}}"#);
        assert_eq!(
            read(dir.path(), &none(), &none()).expect("stored").0["fontSizePx"],
            16
        );
    }

    #[test]
    fn a_write_keeps_every_other_key_and_unknown_preferences() {
        let dir =
            seeded(r#"{"id":"v1","extra":{"a":1},"preferences":{"future":true,"editor":{"x":1}}}"#);
        let general = json!({"theme": "dark", "notAPortableField": 1})
            .as_object()
            .cloned()
            .expect("o");
        let editor = json!({"width": "full"}).as_object().cloned().expect("o");
        write(dir.path(), &general, &editor).expect("write");
        let on_disk: Value =
            serde_json::from_slice(&fs::read(config_path(dir.path())).expect("read"))
                .expect("json");
        assert_eq!(on_disk["id"], "v1");
        assert_eq!(on_disk["extra"], json!({"a": 1}));
        assert_eq!(on_disk["preferences"]["future"], true);
        assert_eq!(on_disk["preferences"]["theme"], "dark");
        assert_eq!(
            on_disk["preferences"]["editor"],
            json!({"x": 1, "width": "full"})
        );
        assert!(on_disk["preferences"].get("notAPortableField").is_none());
        assert!(has_stored(dir.path()));
        assert_eq!(language(dir.path()), None);
    }

    #[test]
    fn a_vault_with_no_config_has_nothing_stored_and_a_first_write_creates_the_file() {
        let dir = tempfile::tempdir().expect("tmp");
        assert!(!has_stored(dir.path()));
        assert!(read(dir.path(), &none(), &none()).is_none());
        write(
            dir.path(),
            &json!({"language": "de"}).as_object().cloned().expect("o"),
            &none(),
        )
        .expect("write");
        assert_eq!(language(dir.path()).as_deref(), Some("de"));
    }
}
