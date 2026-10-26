//! A vault's icon, stored in its own `.memry/config.json` under the top-level `vaultIcon`
//! key, and the minimal read-merge-write that sets it.
//!
//! The key sits beside `preferences`, not inside it: an older build that rewrites
//! `preferences` from the fields it knows would drop an unknown key there. A write here
//! replaces only `vaultIcon` and keeps every other top-level key in value and order. Step 12
//! moves this onto its `vault::config` owner.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

use super::vaults::{RegistryError, VaultRegistry};

const KEY: &str = "vaultIcon";
const MAX_LEN: usize = 64;
const MAX_EMOJI_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVaultIcon {
    /// `icon:<Name>` or an emoji; `None` is the default icon.
    pub value: Option<String>,
    /// Client ms of the last change; the account-wide copy is last writer wins on it.
    pub updated_at: i64,
    /// Changed here and not yet accepted by the server.
    pub pending_sync: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum IconError {
    #[error("not a valid vault icon")]
    Invalid,
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error("no vault is registered at {0}")]
    NotRegistered(String),
    #[error("the vault folder {0} is not reachable")]
    Unreachable(String),
    /// The config exists but is not a JSON object, or cannot be read. Replacing it would
    /// erase the vault's other settings.
    #[error("the vault config {path} cannot be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("the vault config {path} cannot be written: {message}")]
    Write { path: String, message: String },
}

/// `VaultIconSchema`: `icon:<ASCII letters and digits>`, or an emoji of at most 32 bytes-as-
/// chars without whitespace or control characters; `custom:` and anything over 64 are out.
pub fn is_valid(icon: &str) -> bool {
    if icon.is_empty() || icon.chars().count() > MAX_LEN {
        return false;
    }
    if let Some(name) = icon.strip_prefix("icon:") {
        return !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric());
    }
    !icon.starts_with("custom:")
        && icon.chars().count() <= MAX_EMOJI_LEN
        && !icon.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn config_path(vault: &Path) -> PathBuf {
    vault.join(".memry").join("config.json")
}

/// The vault's config as a JSON object, or `None` when it is absent or unusable.
pub fn read_config(vault: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_slice(&std::fs::read(config_path(vault)).ok()?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The stored icon. Tolerant: a value this build cannot draw (a newer build wrote it) reads
/// as no icon and keeps its change time, so sync ordering holds.
pub fn read(vault: &Path) -> Option<StoredVaultIcon> {
    stored_from(read_config(vault)?.get(KEY)?)
}

fn stored_from(raw: &Value) -> Option<StoredVaultIcon> {
    let raw = raw.as_object()?;
    let updated_at = raw.get("updatedAt")?.as_f64().filter(|n| n.is_finite())?;
    Some(StoredVaultIcon {
        value: raw
            .get("value")
            .and_then(Value::as_str)
            .filter(|v| is_valid(v))
            .map(str::to_owned),
        #[allow(clippy::cast_possible_truncation)]
        updated_at: updated_at as i64,
        pending_sync: raw.get("pendingSync").and_then(Value::as_bool) == Some(true),
    })
}

/// Sets (`Some`) or resets (`None`) the icon of a registered, reachable vault and marks it
/// pending sync. `updatedAt` is `max(now_ms, previous + 1)`, so two changes in one
/// millisecond are still ordered and a change wins over an adopted account copy whose clock
/// ran ahead. Nothing is written when the icon is invalid.
pub fn set(
    registry: &VaultRegistry,
    path: &str,
    icon: Option<&str>,
    now_ms: i64,
) -> Result<StoredVaultIcon, IconError> {
    if let Some(icon) = icon
        && !is_valid(icon)
    {
        return Err(IconError::Invalid);
    }
    if registry.get(path).is_none() {
        return Err(IconError::NotRegistered(path.to_owned()));
    }
    let vault = Path::new(path);
    if !vault.is_dir() {
        return Err(IconError::Unreachable(path.to_owned()));
    }
    let file = config_path(vault);
    let mut config = match std::fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => return Err(unreadable(&file, "not a JSON object")),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(err) => return Err(unreadable(&file, &err.to_string())),
    };
    let previous = config
        .get(KEY)
        .and_then(stored_from)
        .map_or(i64::MIN, |i| i.updated_at);
    let next = StoredVaultIcon {
        value: icon.map(str::to_owned),
        updated_at: now_ms.max(previous.saturating_add(1)),
        pending_sync: true,
    };
    config.insert(
        KEY.into(),
        serde_json::json!({
            "value": next.value,
            "updatedAt": next.updated_at,
            "pendingSync": next.pending_sync,
        }),
    );
    write_atomic(&file, &config)?;
    Ok(next)
}

fn unreadable(file: &Path, message: &str) -> IconError {
    IconError::Unreadable {
        path: file.display().to_string(),
        message: message.to_owned(),
    }
}

/// A temp file created exclusively with mode 0600 in the same directory, then renamed over
/// the config. It never follows a symlink planted at the temp name and never leaves a half
/// written config.
fn write_atomic(file: &Path, config: &Map<String, Value>) -> Result<(), IconError> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let fail = |message: String| IconError::Write {
        path: file.display().to_string(),
        message,
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|err| fail(err.to_string()))?;
    }
    let temp = PathBuf::from(format!(
        "{}.{}-{}.tmp",
        file.display(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let bytes = serde_json::to_vec_pretty(config).map_err(|err| fail(err.to_string()))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = options
        .open(&temp)
        .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
        .and_then(|()| std::fs::rename(&temp, file));
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(fail(err.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
