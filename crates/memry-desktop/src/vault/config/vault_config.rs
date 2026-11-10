//! The vault settings of `config.json` that `init.ts` owns (`DEFAULT_CONFIG`), and the cache
//! of `readVaultConfig`.
//!
//! Reads are tolerant: a field of the wrong type reads as its default, and a file that is
//! missing or unusable reads as all defaults, except the exclude patterns (#4118). When the file
//! gives no list of them (missing, unusable, or `excludePatterns` absent or not a list), the
//! kept ones stand in: the ones last read from it, joined at open by the ones the vault last
//! applied on this device ([`applied_exclude_patterns`]). So a broken or recreated file never
//! makes the app watch, write or sync what the user excluded. Electron fell back to the default
//! patterns. A
//! corrupt file is reported once per path and process, since the read runs on most vault
//! operations. The parsed config is cached per file and checked against the file's identity,
//! size and modification time (nanoseconds) on every read, so a read and parse happen only when
//! the file changed, whoever changed it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use memry_core::api::vault::Vault;
use serde_json::{Map, Value};

use super::{ConfigError, Stamp, config_path, open_config, read_object, update};
use crate::vault::layout::DEFAULT_EXCLUDE_PATTERNS;

/// The vault settings, in the `VaultConfig` shape of `packages/contracts/src/vault-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
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

/// A parsed file's config, and whether its `excludePatterns` is a list: the user's patterns.
/// When it is not, the kept patterns stand in for the defaults it holds (module doc).
#[derive(Clone)]
struct Parsed {
    config: VaultConfig,
    listed: bool,
}

impl VaultConfig {
    /// `{ ...DEFAULT_CONFIG, ...parsed }`, field by field: a value of the wrong type is the
    /// default.
    fn from_map(map: &Map<String, Value>) -> Parsed {
        let default = Self::default();
        let text = |key: &str, fallback: String| {
            map.get(key)
                .and_then(Value::as_str)
                .map_or(fallback, str::to_owned)
        };
        let listed = map
            .get("excludePatterns")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
        let config = Self {
            exclude_patterns: listed.clone().unwrap_or(default.exclude_patterns),
            default_note_folder: text("defaultNoteFolder", default.default_note_folder),
            journal_folder: text("journalFolder", default.journal_folder),
            journal_date_format: text("journalDateFormat", default.journal_date_format),
            attachments_folder: text("attachmentsFolder", default.attachments_folder),
            journal_show_in_sidebar: map
                .get("journalShowInSidebar")
                .and_then(Value::as_bool)
                .unwrap_or(default.journal_show_in_sidebar),
        };
        Parsed {
            config,
            listed: listed.is_some(),
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

/// The fields a write changes (`UpdateVaultConfigSchema`). `None` leaves the stored value,
/// whatever it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultConfigPatch {
    #[specta(optional)]
    pub exclude_patterns: Option<Vec<String>>,
    #[specta(optional)]
    pub default_note_folder: Option<String>,
    #[specta(optional)]
    pub journal_folder: Option<String>,
    #[specta(optional)]
    pub journal_date_format: Option<String>,
    #[specta(optional)]
    pub attachments_folder: Option<String>,
    #[specta(optional)]
    pub journal_show_in_sidebar: Option<bool>,
}

struct CacheEntry {
    parsed: Parsed,
    stamp: Stamp,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, CacheEntry>>> = LazyLock::new(Mutex::default);
static WARNED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);
/// Per config path, the exclude patterns that stand in while the file gives none: the ones
/// last read from it, joined by the ones [`applied_exclude_patterns`] found remembered.
static KNOWN_EXCLUDES: LazyLock<Mutex<HashMap<PathBuf, Vec<String>>>> =
    LazyLock::new(Mutex::default);

fn cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CacheEntry>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

fn known_excludes() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Vec<String>>> {
    KNOWN_EXCLUDES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drops every vault's cached config: the app's own lifecycle edges (vault open and close).
pub fn invalidate_vault_config_cache() {
    cache().clear();
}

pub(super) fn invalidate_path(path: &Path) {
    cache().remove(path);
}

/// A corrupt or unreadable config silently reverts the journal settings to defaults, so it is
/// reported, once per path and process. Never the content or the path.
fn warn_once(path: &Path, message: &str) {
    let first = WARNED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf());
    if first {
        tracing::warn!(
            scope = "vault",
            action = "config_corrupt_fallback",
            "vault config unreadable, falling back to defaults and the known exclude patterns: \
             {message}"
        );
    }
}

enum Read {
    Missing,
    Parsed(Parsed),
    /// Why the file cannot be used.
    Unusable(String),
}

/// `config`, with the exclude patterns known for the file at `path` standing in for its own.
fn kept(path: &Path, mut config: VaultConfig) -> VaultConfig {
    if let Some(patterns) = known_excludes().get(path) {
        config.exclude_patterns.clone_from(patterns);
    }
    config
}

/// The config of the parsed file at `path`: its patterns when it lists them, and they are
/// known from now on; else the kept ones.
fn resolve(path: &Path, parsed: Parsed) -> VaultConfig {
    if !parsed.listed {
        return kept(path, parsed.config);
    }
    known_excludes().insert(path.to_path_buf(), parsed.config.exclude_patterns.clone());
    parsed.config
}

/// `readVaultConfig`. Never fails: the defaults stand in for a missing or unusable file, and
/// the kept exclude patterns wherever the file lists none (module doc).
pub fn read_vault_config(vault: &Path) -> VaultConfig {
    let path = config_path(vault);
    match read(vault) {
        Read::Missing => kept(&path, VaultConfig::default()),
        Read::Parsed(parsed) => resolve(&path, parsed),
        Read::Unusable(message) => {
            warn_once(&path, &message);
            kept(&path, VaultConfig::default())
        }
    }
}

/// [`read_vault_config`] that tells an unusable file (`Err`, with why) from a missing one (the
/// defaults), for a caller that must not act on defaults standing in for the user's settings.
pub fn read_vault_config_strict(vault: &Path) -> Result<VaultConfig, String> {
    let path = config_path(vault);
    match read(vault) {
        Read::Missing => Ok(kept(&path, VaultConfig::default())),
        Read::Parsed(parsed) => Ok(resolve(&path, parsed)),
        Read::Unusable(message) => Err(message),
    }
}

/// The exclude patterns an open of `core`'s vault applies: [`read_vault_config`]'s, and the
/// patterns this device applies are remembered in `core` (#4118). Only a file that lists them
/// is remembered. When it lists none (missing, unusable, or no list), the remembered patterns
/// join the ones last read from it, here and in every later read: either can be the newer, so
/// the union excludes what both did, and the remembered ones hold after a restart too.
pub fn applied_exclude_patterns(vault: &Path, core: &Vault) -> Vec<String> {
    let path = config_path(vault);
    match read(vault) {
        Read::Parsed(parsed) if parsed.listed => {
            if let Err(error) = core.remember_exclude_patterns(&parsed.config.exclude_patterns) {
                tracing::error!(
                    scope = "vault",
                    %error,
                    "the exclude patterns were not remembered; an unreadable config falls back \
                     to the ones remembered before"
                );
            }
            resolve(&path, parsed).exclude_patterns
        }
        read => {
            if let Read::Unusable(message) = &read {
                warn_once(&path, message);
            }
            match core.remembered_exclude_patterns() {
                Ok(Some(stored)) => {
                    let mut known = known_excludes();
                    let patterns = known.entry(path.clone()).or_default();
                    for pattern in stored {
                        if !patterns.contains(&pattern) {
                            patterns.push(pattern);
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => tracing::error!(
                    scope = "vault",
                    %error,
                    "the remembered exclude patterns cannot be read"
                ),
            }
            kept(&path, VaultConfig::default()).exclude_patterns
        }
    }
}

fn read(vault: &Path) -> Read {
    let path = config_path(vault);
    let (file, stamp) = match open_config(vault) {
        Ok(Some(opened)) => opened,
        Ok(None) => {
            invalidate_path(&path);
            return Read::Missing;
        }
        Err(message) => {
            invalidate_path(&path);
            return Read::Unusable(message);
        }
    };
    if let Some(entry) = cache().get(&path)
        && entry.stamp == stamp
    {
        return Read::Parsed(entry.parsed.clone());
    }
    match read_object(file) {
        Ok(map) => {
            let parsed = VaultConfig::from_map(&map);
            cache().insert(
                path,
                CacheEntry {
                    parsed: parsed.clone(),
                    stamp,
                },
            );
            Read::Parsed(parsed)
        }
        Err(message) => {
            invalidate_path(&path);
            Read::Unusable(message)
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
    let parsed = update(vault, |map| {
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
    })?;
    Ok(resolve(&config_path(vault), parsed))
}
