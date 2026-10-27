//! `<vault>/.memry/config.json`: the one owner of the vault's config file.
//!
//! The file is shared, key by key, with the Electron build and with older and newer builds of
//! this app: the vault settings of `init.ts` (`excludePatterns`, `journalFolder`, ...), the
//! portable `preferences` object, the top-level `vaultIcon`, and whatever a newer build adds.
//! So every writer goes through [`update`]:
//!
//! - the file is read as a JSON object that keeps key order, only the keys the writer names
//!   change, and an unknown key, or an unknown field inside a known one, survives;
//! - a file that exists but cannot be read or is not a JSON object is never replaced. Only a
//!   missing file is an empty config. The caller gets [`ConfigError::Unreadable`];
//! - writes are serialized by one process-wide lock, so the preferences, the icon and the
//!   vault settings never interleave. Another process (an Electron build open on the same
//!   vault) is not excluded: a write of theirs between our read and our rename can be lost;
//! - the bytes go through [`fs_atomic`](crate::vault::fs_atomic) (temp file, sync, rename), keep
//!   the mode of the file they replace (0600 for a new one), and a path that resolves outside
//!   the vault is never written.
//!
//! The file is untrusted input (a copied archive, a synced share): a read is capped at
//! [`MAX_CONFIG_BYTES`], goes through `open_under_root` so it never blocks on a FIFO or leaves
//! the vault, and parses with `serde_json`'s default recursion limit of 128, which turns a
//! deeper file into an error. (The `unbounded_depth` feature the build enables only adds an
//! opt-in `disable_recursion_limit`; nothing here calls it.)

mod preferences;
mod vault_config;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Map, Value};

pub use preferences::{
    PORTABLE_EDITOR, PORTABLE_GENERAL, accent_color, has_stored_preferences, merge_preferences,
    preferences_language, read_preferences,
};
pub use vault_config::{
    VaultConfig, VaultConfigPatch, invalidate_vault_config_cache, read_vault_config,
    write_vault_config,
};

use super::fs_atomic::{self, WriteError};
use super::layout::MEMRY_DIR;
use super::note_file::{NoteFileError, still_contained, target};
use crate::shell::file_open::{FileId, LinkPolicy, file_identity, open_under_root_with};

pub const CONFIG_FILE: &str = "config.json";
/// The top-level key of the vault icon, beside `preferences`: an older build that rewrites
/// `preferences` from the fields it knows would drop an unknown key inside it.
pub const VAULT_ICON_KEY: &str = "vaultIcon";
/// The i18n key of the message for [`ConfigError::PermissionDenied`], as Electron shows it.
pub const PERMISSION_DENIED_KEY: &str = "errors:vault.permissionDenied";

/// A real config is a few hundred bytes. Past this the file is not read at all.
pub const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

/// `<vault>/.memry/config.json`, vault-relative with `/` separators.
const CONFIG_REL: &str = ".memry/config.json";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The file exists but cannot be read, is not a JSON object, is too large or sits outside
    /// the vault. A write would replace what it could not parse, so it refuses.
    #[error("the vault config {path} cannot be read: {message}")]
    Unreadable { path: String, message: String },
    /// `EACCES` or `EPERM` writing the file. The message is [`PERMISSION_DENIED_KEY`].
    #[error("no permission to write the vault config")]
    PermissionDenied,
    #[error("the vault config {path} cannot be written: {message}")]
    Write { path: String, message: String },
}

pub fn config_path(vault: &Path) -> PathBuf {
    vault.join(MEMRY_DIR).join(CONFIG_FILE)
}

/// What the file holds.
#[derive(Debug)]
pub(crate) enum Stored {
    Missing,
    Object(Map<String, Value>),
    /// Why it cannot be used. Never contains file content.
    Unusable(String),
}

/// Size, modification time (nanoseconds) and identity of the opened file: what the typed
/// reader's cache compares, as `readVaultConfig` compares inode, size and mtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    id: FileId,
    size: u64,
    mtime_ns: u128,
}

/// Opens the config for reading. `Ok(None)` when it is not there.
pub(crate) fn open_config(vault: &Path) -> Result<Option<(File, Stamp)>, String> {
    let file = match open_under_root_with(vault, CONFIG_REL, LinkPolicy::Allow) {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let (id, _) = file_identity(&file).map_err(|e| e.to_string())?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Ok(Some((
        file,
        Stamp {
            id,
            size: meta.len(),
            mtime_ns,
        },
    )))
}

/// The JSON object in an opened config, or why it is not one.
pub(crate) fn read_object(file: File) -> Result<Map<String, Value>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(format!("larger than {MAX_CONFIG_BYTES} bytes"));
    }
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("not a JSON object".to_owned()),
        Err(error) => Err(format!("not valid JSON: {error}")),
    }
}

pub(crate) fn load(vault: &Path) -> Stored {
    match open_config(vault) {
        Ok(None) => Stored::Missing,
        Ok(Some((file, _))) => match read_object(file) {
            Ok(map) => Stored::Object(map),
            Err(message) => Stored::Unusable(message),
        },
        Err(message) => Stored::Unusable(message),
    }
}

/// The config as a JSON object, or `None` when it is missing or unusable. For readers that
/// degrade to defaults.
pub fn read_map(vault: &Path) -> Option<Map<String, Value>> {
    match load(vault) {
        Stored::Object(map) => Some(map),
        Stored::Missing | Stored::Unusable(_) => None,
    }
}

/// Serializes every write of every vault's config in this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn unreadable(vault: &Path, message: String) -> ConfigError {
    ConfigError::Unreadable {
        path: config_path(vault).display().to_string(),
        message,
    }
}

/// Reads the config, lets `change` edit it and writes it back. `change` runs under the write
/// lock on the config as the file holds it now, so keys written meanwhile survive. A missing
/// file starts as an empty config; an unusable one is an error and stays as it is.
pub fn update<R>(
    vault: &Path,
    change: impl FnOnce(&mut Map<String, Value>) -> R,
) -> Result<R, ConfigError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = match load(vault) {
        Stored::Missing => Map::new(),
        Stored::Object(map) => map,
        Stored::Unusable(message) => return Err(unreadable(vault, message)),
    };
    let result = change(&mut map);
    write_map(vault, &map)?;
    vault_config::invalidate_path(&config_path(vault));
    Ok(result)
}

fn write_map(vault: &Path, map: &Map<String, Value>) -> Result<(), ConfigError> {
    let bytes = serde_json::to_vec_pretty(map).map_err(|e| ConfigError::Write {
        path: config_path(vault).display().to_string(),
        message: e.to_string(),
    })?;
    let (path, aimed_at) = target(vault, CONFIG_REL).map_err(|error| match error {
        NoteFileError::Open(open) => unreadable(vault, open.to_string()),
        other => unreadable(vault, other.to_string()),
    })?;
    let delays = fs_atomic::RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut after_check = || {};
    let mut check = still_contained(vault, CONFIG_REL, &path, aimed_at, &mut after_check);
    fs_atomic::atomic_write_checked(&path, &bytes, &delays, &mut check).map_err(write_error)
}

fn write_error(error: WriteError) -> ConfigError {
    if error.source.kind() == std::io::ErrorKind::PermissionDenied {
        tracing::warn!(scope = "vault_config", "the vault config is not writable");
        return ConfigError::PermissionDenied;
    }
    ConfigError::Write {
        path: error.path.display().to_string(),
        message: error.source.to_string(),
    }
}

/// The raw `vaultIcon` value, whatever shape a build wrote.
pub fn read_vault_icon(vault: &Path) -> Option<Value> {
    read_map(vault)?.get(VAULT_ICON_KEY).cloned()
}

/// Replaces `vaultIcon` with what `build` makes of the current value and keeps every other key
/// in value and order.
pub fn write_vault_icon(
    vault: &Path,
    build: impl FnOnce(Option<&Value>) -> Value,
) -> Result<(), ConfigError> {
    update(vault, |map| {
        let next = build(map.get(VAULT_ICON_KEY));
        map.insert(VAULT_ICON_KEY.to_owned(), next);
    })
}
