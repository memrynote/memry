//! The vault registry: the `vaults` and `currentVault` keys of `memry-config.json`.
//!
//! An entry is the Electron `StoredVaultInfo`. Edits change the known fields of the existing
//! JSON object in place, so a field a newer build added survives, and a build that reads the
//! file back sees the shape it wrote.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config::{AppConfig, ConfigError};
use super::vault_icon;

/// The accent the renderer draws when a vault's `config.json` names none
/// (`DEFAULT_ACCENT_COLOR` in `packages/contracts/src/color-themes.ts`).
const DEFAULT_ACCENT: &str = "#f97316";

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// `vaults` holds something that is not a list. Replacing it would erase whatever it is.
    #[error("the `vaults` key of the config is not a list")]
    Malformed,
    #[error("no vault is registered at {0}")]
    NotRegistered(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountBinding {
    pub user_id: String,
    /// `sync` or `local`.
    pub mode: String,
}

/// What the registry stores per vault (`StoredVaultInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVault {
    pub path: String,
    pub name: String,
    pub note_count: u32,
    pub task_count: u32,
    /// ISO 8601 with milliseconds and `Z`, as `Date.toISOString()` writes it.
    pub last_opened: String,
    pub is_default: bool,
    pub vault_uuid: Option<String>,
    pub account_binding: Option<AccountBinding>,
}

/// The `VaultInfo` of `packages/contracts/src/vault-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub note_count: u32,
    pub task_count: u32,
    pub last_opened: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SandboxInfo {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetVaultsResponse {
    pub vaults: Vec<VaultInfo>,
    pub current_vault: Option<String>,
    pub sandbox: SandboxInfo,
}

#[derive(Clone)]
pub struct VaultRegistry {
    config: Arc<AppConfig>,
}

impl VaultRegistry {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &Arc<AppConfig> {
        &self.config
    }

    /// Every registered vault with its reachability, accent and icon read from the vault's
    /// own `.memry/config.json` (absent for a folder that is not there). The sandbox vault is
    /// never a list entry; the caller passes its state.
    pub fn list(&self, sandbox: SandboxInfo) -> GetVaultsResponse {
        // Copy what the entries say under the lock; the folder checks and config reads below
        // can block on a dead network share or a sleeping drive and must not hold it.
        let (stored, current_vault) = self.config.read(|map| {
            (
                vault_objects(map).filter_map(to_stored).collect::<Vec<_>>(),
                current_of(map),
            )
        });
        GetVaultsResponse {
            vaults: stored.into_iter().map(to_info).collect(),
            current_vault,
            sandbox,
        }
    }

    pub fn get(&self, path: &str) -> Option<StoredVault> {
        self.config.read(|map| {
            vault_objects(map)
                .find(|o| path_of(o) == Some(path))
                .and_then(to_stored)
        })
    }

    /// The last vault the user opened.
    pub fn current(&self) -> Option<String> {
        self.config.read(current_of)
    }

    /// Adds or updates the entry for `stored.path`. An update changes the known fields and
    /// keeps every unknown one; it never erases a stored `vaultUuid` or `accountBinding`.
    pub fn upsert(&self, stored: &StoredVault) -> Result<(), RegistryError> {
        self.config.update(|map| upsert_in(map, stored))
    }

    /// A vault was opened: registers it when new (first vault becomes the default), stamps
    /// `lastOpened`, and makes it the current vault. Returns the stored entry.
    pub fn record_open(&self, path: &str, now_ms: i64) -> Result<StoredVault, RegistryError> {
        self.config.update(|map| {
            let existing = vault_objects(map)
                .find(|o| path_of(o) == Some(path))
                .and_then(to_stored);
            let first = vault_objects(map).next().is_none();
            // `noteCount` is carried, not recomputed: Electron counted markdown files on
            // open (`createVaultInfo`), which needs the vault file walker and its exclude
            // patterns. That is Step 12 (#3529)'s; until it lands the picker shows the
            // count a previous build stored (0 for a vault this build registered).
            let stored = StoredVault {
                path: path.to_owned(),
                name: existing
                    .as_ref()
                    .map_or_else(|| basename(path), |e| e.name.clone()),
                note_count: existing.as_ref().map_or(0, |e| e.note_count),
                task_count: existing.as_ref().map_or(0, |e| e.task_count),
                last_opened: iso_millis(now_ms),
                is_default: existing.as_ref().map_or(first, |e| e.is_default),
                vault_uuid: existing.as_ref().and_then(|e| e.vault_uuid.clone()),
                account_binding: existing.and_then(|e| e.account_binding),
            };
            upsert_in(map, &stored)?;
            map.insert("currentVault".into(), Value::String(path.to_owned()));
            Ok::<_, RegistryError>(stored)
        })
    }

    /// Forgets the vault. Never touches the folder. Clears `currentVault` when it matches.
    pub fn remove(&self, path: &str) -> Result<(), RegistryError> {
        self.config.update(|map| {
            if let Some(list) = vaults_mut(map)? {
                list.retain(|v| v.get("path").and_then(Value::as_str) != Some(path));
            }
            if current_of(map).as_deref() == Some(path) {
                map.insert("currentVault".into(), Value::Null);
            }
            Ok::<_, RegistryError>(())
        })
    }

    /// Exactly one entry is the default afterwards.
    pub fn set_default(&self, path: &str) -> Result<(), RegistryError> {
        self.config.update(|map| {
            let list = vaults_mut(map)?
                .filter(|list| {
                    list.iter()
                        .any(|v| v.get("path").and_then(Value::as_str) == Some(path))
                })
                .ok_or_else(|| RegistryError::NotRegistered(path.to_owned()))?;
            for entry in list.iter_mut().filter_map(Value::as_object_mut) {
                let is_target = entry.get("path").and_then(Value::as_str) == Some(path);
                entry.insert("isDefault".into(), Value::Bool(is_target));
            }
            Ok(())
        })
    }

    /// Clears `currentVault` (a vault that failed to open at startup).
    pub fn clear_current(&self) -> Result<(), RegistryError> {
        self.config.update(|map| {
            if map.get("currentVault").is_some_and(|v| !v.is_null()) {
                map.insert("currentVault".into(), Value::Null);
            }
            Ok::<_, RegistryError>(())
        })
    }
}

fn vault_objects(map: &Map<String, Value>) -> impl Iterator<Item = &Map<String, Value>> {
    map.get("vaults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

fn vaults_mut(map: &mut Map<String, Value>) -> Result<Option<&mut Vec<Value>>, RegistryError> {
    match map.get_mut("vaults") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(list)) => Ok(Some(list)),
        Some(_) => Err(RegistryError::Malformed),
    }
}

fn current_of(map: &Map<String, Value>) -> Option<String> {
    map.get("currentVault")?.as_str().map(str::to_owned)
}

fn path_of(entry: &Map<String, Value>) -> Option<&str> {
    entry.get("path")?.as_str()
}

fn to_stored(entry: &Map<String, Value>) -> Option<StoredVault> {
    let path = path_of(entry)?.to_owned();
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
    let count = |key: &str| {
        entry
            .get(key)
            .and_then(Value::as_u64)
            .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
    };
    Some(StoredVault {
        name: text("name").unwrap_or_else(|| basename(&path)),
        note_count: count("noteCount"),
        task_count: count("taskCount"),
        last_opened: text("lastOpened").unwrap_or_default(),
        is_default: entry.get("isDefault").and_then(Value::as_bool) == Some(true),
        vault_uuid: text("vaultUuid"),
        account_binding: entry
            .get("accountBinding")
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        path,
    })
}

fn to_info(stored: StoredVault) -> VaultInfo {
    let reachable = Path::new(&stored.path).is_dir();
    VaultInfo {
        accent_color: reachable.then(|| accent_of(&stored.path)),
        icon: reachable
            .then(|| vault_icon::read(Path::new(&stored.path)).and_then(|icon| icon.value))
            .flatten(),
        is_missing: Some(!reachable),
        path: stored.path,
        name: stored.name,
        note_count: stored.note_count,
        task_count: stored.task_count,
        last_opened: stored.last_opened,
        is_default: stored.is_default,
        vault_uuid: stored.vault_uuid,
    }
}

/// `preferences.accentColor` of the vault's config, else the default accent.
fn accent_of(vault: &str) -> String {
    vault_icon::read_config(Path::new(vault))
        .and_then(|config| {
            config
                .get("preferences")?
                .get("accentColor")?
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| DEFAULT_ACCENT.to_owned())
}

fn upsert_in(map: &mut Map<String, Value>, stored: &StoredVault) -> Result<(), RegistryError> {
    if !map.contains_key("vaults") || map["vaults"].is_null() {
        map.insert("vaults".into(), Value::Array(Vec::new()));
    }
    let list = vaults_mut(map)?.ok_or(RegistryError::Malformed)?;
    let index = list
        .iter()
        .position(|v| v.get("path").and_then(Value::as_str) == Some(stored.path.as_str()));
    let entry = match index {
        Some(i) => &mut list[i],
        None => {
            list.push(Value::Object(Map::new()));
            list.last_mut().ok_or(RegistryError::Malformed)?
        }
    };
    let Value::Object(fields) = entry else {
        return Err(RegistryError::Malformed);
    };
    fields.insert("path".into(), Value::String(stored.path.clone()));
    fields.insert("name".into(), Value::String(stored.name.clone()));
    fields.insert("noteCount".into(), Value::from(stored.note_count));
    fields.insert("taskCount".into(), Value::from(stored.task_count));
    fields.insert(
        "lastOpened".into(),
        Value::String(stored.last_opened.clone()),
    );
    fields.insert("isDefault".into(), Value::Bool(stored.is_default));
    if let Some(uuid) = &stored.vault_uuid {
        fields.insert("vaultUuid".into(), Value::String(uuid.clone()));
    }
    if let Some(binding) = &stored.account_binding
        && let Ok(value) = serde_json::to_value(binding)
    {
        fields.insert("accountBinding".into(), value);
    }
    Ok(())
}

/// The vault's name: its folder's basename (`getVaultName`).
pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// `Date.prototype.toISOString` for a unix time in milliseconds.
pub fn iso_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests;
