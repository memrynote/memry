//! The portable `preferences` object of `config.json` (`vault/vault-preferences.ts`): the
//! theme, fonts, language and editor choices that travel with the vault folder.
//!
//! Reads are tolerant on purpose: the file is written by older and newer builds, so an
//! unrecognised value degrades to the default and an unknown key survives a write. A merge
//! changes only the fields it names and goes through [`update`](super::update), so every other
//! key of the file, and a file that cannot be parsed, are left as they are.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::{ConfigError, read_map, update};

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

/// Whether `config.json` already carries a `preferences` object. This, not the values, is the
/// marker that the vault's settings have been written once.
pub fn has_stored_preferences(vault: &Path) -> bool {
    read_map(vault).is_some_and(|c| c.get("preferences").is_some_and(|p| !p.is_null()))
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
pub fn read_preferences(
    vault: &Path,
    defaults_general: &Map<String, Value>,
    defaults_editor: &Map<String, Value>,
) -> Option<(Map<String, Value>, Map<String, Value>)> {
    let config = read_map(vault)?;
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

/// Merges portable `general` and `editor` fields into `preferences`. Fields the vault file
/// already has and the patch does not name stay as written, including unknown ones. A config
/// that exists but cannot be read or parsed is an error and stays untouched.
pub fn merge_preferences(
    vault: &Path,
    general: &Map<String, Value>,
    editor: &Map<String, Value>,
) -> Result<(), ConfigError> {
    if general.is_empty() && editor.is_empty() {
        return Ok(());
    }
    update(vault, |config| {
        // In place: `Map::remove` under `preserve_order` swaps the last key into the hole, so
        // taking `preferences` out and putting it back would move keys around the file.
        let prefs = object_at(config, "preferences");
        for (field, value) in general {
            if PORTABLE_GENERAL.contains(&field.as_str()) {
                prefs.insert(field.clone(), value.clone());
            }
        }
        if editor.keys().any(|f| PORTABLE_EDITOR.contains(&f.as_str())) {
            let stored = object_at(prefs, "editor");
            for (field, value) in editor {
                if PORTABLE_EDITOR.contains(&field.as_str()) {
                    stored.insert(field.clone(), value.clone());
                }
            }
        }
    })
}

/// The object under `key`, created (or replacing a non-object) in place.
fn object_at<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = map
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    match slot {
        Value::Object(inner) => inner,
        _ => unreachable!("the slot was made an object above"),
    }
}

/// The vault's language preference, when it is a string.
pub fn preferences_language(vault: &Path) -> Option<String> {
    read_map(vault)?
        .get("preferences")?
        .get("language")?
        .as_str()
        .map(str::to_owned)
}

/// `preferences.accentColor`, when it is a string.
pub fn accent_color(vault: &Path) -> Option<String> {
    read_map(vault)?
        .get("preferences")?
        .get("accentColor")?
        .as_str()
        .map(str::to_owned)
}
