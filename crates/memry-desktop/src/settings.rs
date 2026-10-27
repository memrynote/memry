//! Settings for the shell: one service over a vault's `AppSettings`.
//!
//! Core owns the groups, the local and synced split and the clocks. This service adds what is
//! device-wide: the device identity every synced write needs, the vault-portable preferences in
//! `config.json`, the startup cache in `memry-config.json`, and the answer while no vault is
//! open (the group defaults). It does not emit events or telemetry; the shell does that from
//! the returned [`SettingsChange`].

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::StorageError;
use memry_core::domain::app_settings::{AppSettings, SettingsChange, group_defaults};
use memry_core::seams::secure_store::SecureStore;
use serde_json::{Map, Value};

use crate::registry::AppConfig;
use crate::session::OpenVault;
use crate::startup_values;
use crate::vault::config;

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    /// A write needs the vault it belongs to.
    #[error("no vault is open")]
    NoVault,
    /// The value is not one the group accepts, or the group is unknown. Nothing was written.
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
}

impl From<StorageError> for SettingsError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Invalid { what } => Self::Invalid(what),
            other => Self::Failed(other.to_string()),
        }
    }
}

/// A group read: the value and whether a damaged row was reset to produce it (the shell logs
/// `settings_group_corrupted_<group>`).
pub struct Read {
    pub value: Map<String, Value>,
    pub corrupt_reset: bool,
}

#[derive(Clone)]
pub struct SettingsService {
    store: Arc<dyn SecureStore>,
    config: Arc<AppConfig>,
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl SettingsService {
    pub fn new(store: Arc<dyn SecureStore>, config: Arc<AppConfig>) -> Self {
        Self { store, config }
    }

    pub fn config(&self) -> &Arc<AppConfig> {
        &self.config
    }

    fn settings(&self, vault: &OpenVault) -> Result<AppSettings, SettingsError> {
        // Mints the device key on the first synced write of a profile; sign-in reuses it.
        ensure_device_identity(self.store.clone())
            .map_err(|e| SettingsError::Failed(e.to_string()))?;
        vault
            .vault
            .app_settings(self.store.clone())
            .map_err(|e| SettingsError::Failed(e.to_string()))
    }

    /// A group of the open vault, or its defaults while none is open.
    pub fn read_group(
        &self,
        vault: Option<&OpenVault>,
        group: &str,
    ) -> Result<Read, SettingsError> {
        let Some(vault) = vault else {
            let defaults = group_defaults(group).ok_or_else(|| {
                SettingsError::Invalid(format!("settings group `{group}` is not known"))
            })?;
            return Ok(Read {
                value: object(defaults),
                corrupt_reset: false,
            });
        };
        let read = self.settings(vault)?.get_group(group)?;
        Ok(Read {
            value: object(read.value),
            corrupt_reset: read.corrupt_reset,
        })
    }

    /// Writes a patch, then mirrors the portable fields to the vault's `config.json` and the
    /// startup values to `memry-config.json`.
    pub fn write_group(
        &self,
        vault: Option<&OpenVault>,
        group: &str,
        patch: Map<String, Value>,
    ) -> Result<SettingsChange, SettingsError> {
        let vault = vault.ok_or(SettingsError::NoVault)?;
        let settings = self.settings(vault)?;
        let change = settings.set_group(group, patch.clone())?;
        self.mirror(vault, &settings, group, &patch);
        Ok(change)
    }

    fn mirror(
        &self,
        vault: &OpenVault,
        settings: &AppSettings,
        group: &str,
        patch: &Map<String, Value>,
    ) {
        match group {
            "general" => {
                if let Err(error) = config::merge_preferences(&vault.path, patch, &Map::new()) {
                    tracing::warn!(
                        scope = "Settings",
                        "could not write the vault preferences: {error}"
                    );
                }
                if let Ok(read) = settings.get_group("general") {
                    startup_values::cache(&self.config, &object(read.value));
                }
            }
            "editor" => {
                if let Err(error) = config::merge_preferences(&vault.path, &Map::new(), patch) {
                    tracing::warn!(
                        scope = "Settings",
                        "could not write the vault preferences: {error}"
                    );
                }
            }
            _ => {}
        }
    }

    pub fn get_path(&self, vault: &OpenVault, path: &str) -> Result<Option<Value>, SettingsError> {
        Ok(self.settings(vault)?.get_path(path)?)
    }

    pub fn get_local(
        &self,
        vault: Option<&OpenVault>,
        key: &str,
    ) -> Result<Option<Value>, SettingsError> {
        match vault {
            Some(vault) => Ok(self.settings(vault)?.get_local(key)?),
            None => Ok(None),
        }
    }

    pub fn set_local(
        &self,
        vault: Option<&OpenVault>,
        key: &str,
        value: &Value,
    ) -> Result<SettingsChange, SettingsError> {
        let vault = vault.ok_or(SettingsError::NoVault)?;
        Ok(self.settings(vault)?.set_local(key, value)?)
    }

    /// Resets one group's local fields and synced fields to the defaults.
    pub fn reset_group(
        &self,
        vault: Option<&OpenVault>,
        group: &str,
    ) -> Result<SettingsChange, SettingsError> {
        let defaults = group_defaults(group).ok_or_else(|| {
            SettingsError::Invalid(format!("settings group `{group}` is not known"))
        })?;
        self.write_group(vault, group, object(defaults))
    }

    /// On vault open: seeds the vault's settings from the `config.json` preferences once, while
    /// every portable value is still the default, and gives a vault with no preferences the
    /// app-level language the user picked on the first-run screens. Refreshes the startup cache.
    pub fn on_open(&self, vault: &OpenVault) -> Result<(), SettingsError> {
        let settings = self.settings(vault)?;
        let general_now = object(settings.get_group("general")?.value);
        let editor_now = object(settings.get_group("editor")?.value);
        let general_defaults = object(group_defaults("general").unwrap_or_default());
        let editor_defaults = object(group_defaults("editor").unwrap_or_default());

        if let Some((general, editor)) =
            config::read_preferences(&vault.path, &general_defaults, &editor_defaults)
        {
            let untouched = config::PORTABLE_GENERAL
                .iter()
                .all(|f| general_now.get(*f) == general_defaults.get(*f))
                && config::PORTABLE_EDITOR
                    .iter()
                    .all(|f| editor_now.get(*f) == editor_defaults.get(*f));
            if untouched {
                let general: Map<String, Value> = general
                    .into_iter()
                    .filter(|(f, v)| general_defaults.get(f) != Some(v))
                    .collect();
                let editor: Map<String, Value> = editor
                    .into_iter()
                    .filter(|(f, v)| editor_defaults.get(f) != Some(v))
                    .collect();
                // A value this build refuses (a newer build's) must not block the open.
                for (group, patch) in [("general", general), ("editor", editor)] {
                    if patch.is_empty() {
                        continue;
                    }
                    if let Err(error) = settings.set_group(group, patch) {
                        tracing::warn!(
                            scope = "Settings",
                            "vault preferences for `{group}` were not applied: {error}"
                        );
                    }
                }
            }
        } else if let Some(locale) = crate::locale::stored(&self.config) {
            let patch = Map::from_iter([("language".to_owned(), Value::from(locale))]);
            if let Err(error) = config::merge_preferences(&vault.path, &patch, &Map::new()) {
                tracing::warn!(
                    scope = "Settings",
                    "could not seed the vault language: {error}"
                );
            }
            settings.set_group("general", patch)?;
        }
        startup_values::cache(&self.config, &object(settings.get_group("general")?.value));
        Ok(())
    }
}
