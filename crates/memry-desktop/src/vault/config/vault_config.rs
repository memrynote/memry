//! The vault settings of `config.json` that `init.ts` owns (`DEFAULT_CONFIG`), and the cache
//! of `readVaultConfig`.
//!
//! Reads are tolerant: a field of the wrong type reads as its default, and a file that is
//! missing or unusable reads as all defaults. A corrupt file is reported once per path and
//! process, since the read runs on most vault operations. The parsed config is cached per
//! file and checked against the file's identity, size and modification time (nanoseconds) on
//! every read, so a read and parse happen only when the file changed, whoever changed it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value};

use super::{ConfigError, Stamp, config_path, open_config, read_object, update};
use crate::vault::layout::DEFAULT_EXCLUDE_PATTERNS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultConfig {
    pub exclude_patterns: Vec<String>,
    pub default_note_folder: String,
    pub journal_folder: String,
    pub journal_date_format: String,
    pub attachments_folder: String,
    pub journal_show_in_sidebar: bool,
}

impl Default for VaultConfig {
    /// `DEFAULT_CONFIG` of `init.ts`.
    fn default() -> Self {
        Self {
            exclude_patterns: DEFAULT_EXCLUDE_PATTERNS.map(str::to_owned).to_vec(),
            default_note_folder: String::new(),
            journal_folder: "journal".to_owned(),
            journal_date_format: "YYYY-MM-DD".to_owned(),
            attachments_folder: "attachments".to_owned(),
            journal_show_in_sidebar: false,
        }
    }
}

impl VaultConfig {
    /// `{ ...DEFAULT_CONFIG, ...parsed }`, field by field: a value of the wrong type is the
    /// default.
    fn from_map(map: &Map<String, Value>) -> Self {
        let default = Self::default();
        let text = |key: &str, fallback: String| {
            map.get(key)
                .and_then(Value::as_str)
                .map_or(fallback, str::to_owned)
        };
        Self {
            exclude_patterns: map.get("excludePatterns").and_then(Value::as_array).map_or(
                default.exclude_patterns,
                |items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                },
            ),
            default_note_folder: text("defaultNoteFolder", default.default_note_folder),
            journal_folder: text("journalFolder", default.journal_folder),
            journal_date_format: text("journalDateFormat", default.journal_date_format),
            attachments_folder: text("attachmentsFolder", default.attachments_folder),
            journal_show_in_sidebar: map
                .get("journalShowInSidebar")
                .and_then(Value::as_bool)
                .unwrap_or(default.journal_show_in_sidebar),
        }
    }

    /// The default config as the JSON object `initVault` writes, in its key order.
    pub(crate) fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert(
            "excludePatterns".into(),
            self.exclude_patterns.clone().into(),
        );
        map.insert(
            "defaultNoteFolder".into(),
            self.default_note_folder.clone().into(),
        );
        map.insert("journalFolder".into(), self.journal_folder.clone().into());
        map.insert(
            "journalDateFormat".into(),
            self.journal_date_format.clone().into(),
        );
        map.insert(
            "attachmentsFolder".into(),
            self.attachments_folder.clone().into(),
        );
        map.insert(
            "journalShowInSidebar".into(),
            self.journal_show_in_sidebar.into(),
        );
        map
    }
}

/// The fields a write changes. `None` leaves the stored value, whatever it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultConfigPatch {
    pub exclude_patterns: Option<Vec<String>>,
    pub default_note_folder: Option<String>,
    pub journal_folder: Option<String>,
    pub journal_date_format: Option<String>,
    pub attachments_folder: Option<String>,
    pub journal_show_in_sidebar: Option<bool>,
}

struct CacheEntry {
    config: VaultConfig,
    stamp: Stamp,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, CacheEntry>>> = LazyLock::new(Mutex::default);
static WARNED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);

fn cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CacheEntry>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drops every vault's cached config: the app's own lifecycle edges (vault open and close).
pub fn invalidate_vault_config_cache() {
    cache().clear();
}

pub(super) fn invalidate_path(path: &Path) {
    cache().remove(path);
}

/// A corrupt or unreadable config silently reverts the journal and exclude settings to
/// defaults, so it is reported, once per path and process. Never the content or the path.
fn warn_once(path: &Path, message: &str) {
    let first = WARNED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf());
    if first {
        tracing::warn!(
            scope = "vault",
            action = "config_corrupt_fallback",
            "vault config unreadable, falling back to defaults: {message}"
        );
    }
}

/// `readVaultConfig`. Never fails: the defaults stand in for a missing or unusable file.
pub fn read_vault_config(vault: &Path) -> VaultConfig {
    let path = config_path(vault);
    let (file, stamp) = match open_config(vault) {
        Ok(Some(opened)) => opened,
        Ok(None) => {
            invalidate_path(&path);
            return VaultConfig::default();
        }
        Err(message) => {
            invalidate_path(&path);
            warn_once(&path, &message);
            return VaultConfig::default();
        }
    };
    if let Some(entry) = cache().get(&path)
        && entry.stamp == stamp
    {
        return entry.config.clone();
    }
    match read_object(file) {
        Ok(map) => {
            let config = VaultConfig::from_map(&map);
            cache().insert(
                path,
                CacheEntry {
                    config: config.clone(),
                    stamp,
                },
            );
            config
        }
        Err(message) => {
            invalidate_path(&path);
            warn_once(&path, &message);
            VaultConfig::default()
        }
    }
}

/// `writeVaultConfig`: changes the named fields, keeps every other key (unknown ones too), and
/// returns the config as read back. A missing file is created; an unusable one is an error and
/// stays as it is (Electron replaced it with the defaults and the patch).
pub fn write_vault_config(
    vault: &Path,
    patch: &VaultConfigPatch,
) -> Result<VaultConfig, ConfigError> {
    update(vault, |map| {
        let mut set = |key: &str, value: Value| {
            map.insert(key.to_owned(), value);
        };
        if let Some(v) = &patch.exclude_patterns {
            set("excludePatterns", v.clone().into());
        }
        if let Some(v) = &patch.default_note_folder {
            set("defaultNoteFolder", v.clone().into());
        }
        if let Some(v) = &patch.journal_folder {
            set("journalFolder", v.clone().into());
        }
        if let Some(v) = &patch.journal_date_format {
            set("journalDateFormat", v.clone().into());
        }
        if let Some(v) = &patch.attachments_folder {
            set("attachmentsFolder", v.clone().into());
        }
        if let Some(v) = patch.journal_show_in_sidebar {
            set("journalShowInSidebar", v.into());
        }
        VaultConfig::from_map(map)
    })
}
