//! A vault's icon, stored in its own `.memry/config.json` under the top-level `vaultIcon`
//! key. The file, its atomic write and the keys this module leaves alone belong to
//! [`crate::vault::config`]; this module owns the icon's rules: what a valid icon is and the
//! `updatedAt` stamp.

use std::path::Path;

use serde_json::Value;

use super::vaults::{RegistryError, VaultRegistry};
use crate::vault::config::{self, ConfigError};

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

/// `VaultIconSchema`: `icon:<ASCII letters and digits>`, or an emoji of at most 32 UTF-16 units
/// without whitespace or control characters; `custom:` and anything over 64 are out.
pub fn is_valid(icon: &str) -> bool {
    // Lengths are UTF-16 code units, as JavaScript's `string.length` counts them in
    // `VaultIconSchema`, so an emoji outside the BMP counts 2.
    let units = icon.encode_utf16().count();
    if icon.is_empty() || units > MAX_LEN {
        return false;
    }
    if let Some(name) = icon.strip_prefix("icon:") {
        return !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric());
    }
    !icon.starts_with("custom:")
        && units <= MAX_EMOJI_LEN
        && !icon.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The stored icon. Tolerant: a value this build cannot draw (a newer build wrote it) reads
/// as no icon and keeps its change time, so sync ordering holds.
pub fn read(vault: &Path) -> Option<StoredVaultIcon> {
    stored_from(&config::read_vault_icon(vault)?)
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
    // The stamp is computed from the value read under the config's write lock, so two
    // changes in one millisecond stay ordered and a concurrent write cannot be overwritten.
    let mut written = None;
    config::write_vault_icon(vault, |previous| {
        let previous = previous
            .and_then(stored_from)
            .map_or(i64::MIN, |i| i.updated_at);
        let next = StoredVaultIcon {
            value: icon.map(str::to_owned),
            updated_at: now_ms.max(previous.saturating_add(1)),
            pending_sync: true,
        };
        let raw = serde_json::json!({
            "value": next.value,
            "updatedAt": next.updated_at,
            "pendingSync": next.pending_sync,
        });
        written = Some(next);
        raw
    })
    .map_err(|error| match error {
        ConfigError::Unreadable { path, message } => IconError::Unreadable { path, message },
        ConfigError::PermissionDenied => IconError::Write {
            path: vault.display().to_string(),
            message: error.to_string(),
        },
        ConfigError::Write { path, message } => IconError::Write { path, message },
    })?;
    written.ok_or_else(|| IconError::Write {
        path: vault.display().to_string(),
        message: "the icon was not built".to_owned(),
    })
}

#[cfg(test)]
mod tests;
