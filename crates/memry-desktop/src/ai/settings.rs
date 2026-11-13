//! The inline AI settings of a vault (`ai-inline-handlers.ts` of Electron) with the API key in
//! the OS keychain.
//!
//! The non-secret fields stay in the vault's `ai-inline` local settings group, the same JSON
//! Electron wrote (`{enabled, provider, model, apiKey, baseUrl}`), with `apiKey` always empty
//! when this build writes it. The key lives under [`SERVICE`] / [`InlineAiStore::account`]. A
//! row that still carries a key (Electron's plaintext, or one imported from it) moves into the
//! keychain on first read: written, read back, compared, and only then emptied in the row. When
//! the keychain cannot be reached the row keeps the key and this session uses it; the next read
//! tries again. Compatibility contract: rows with a plaintext `apiKey` stay readable forever.

use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::errors::SecureStoreError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use super::cached_key::CachedKey;
use super::provider::{AiProvider, OLLAMA_DEFAULT_BASE_URL, url_host};
use crate::seams::secure_store::{GenericSecrets, device_account};
use crate::session::OpenVault;
use crate::settings::{SettingsError, SettingsService};

/// The settings group of the inline AI fields. Closed to the generic settings commands, which
/// would hand a plaintext key to the webview.
pub const GROUP: &str = "ai-inline";
/// The keychain service of the inline AI key.
pub const SERVICE: &str = "com.memrynote.memry.ai.inline";
/// What the renderer gets in place of a stored key, and what it sends back to leave it alone
/// (`MASKED_KEY` of Electron: eight U+2022 bullets).
pub const MASKED_KEY: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

const SCOPE: &str = "AIInline";

/// `AIInlineSettings` of `@memry/contracts/ai-inline-channels`. Outside Rust `api_key` is
/// always [`MASKED_KEY`] or empty.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InlineAiSettings {
    pub enabled: bool,
    pub provider: AiProvider,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl std::fmt::Debug for InlineAiSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InlineAiSettings")
            .field("enabled", &self.enabled)
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field(
                "api_key",
                &(!self.api_key.is_empty()).then_some("<redacted>"),
            )
            .field("base_url", &url_host(&self.base_url))
            .finish()
    }
}

impl Default for InlineAiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: AiProvider::Ollama,
            model: "llama3.2".to_owned(),
            api_key: String::new(),
            base_url: OLLAMA_DEFAULT_BASE_URL.to_owned(),
        }
    }
}

impl InlineAiSettings {
    /// The renderer's copy: the key replaced by [`MASKED_KEY`] when one exists.
    pub fn masked(mut self) -> Self {
        if !self.api_key.is_empty() {
            self.api_key = MASKED_KEY.to_owned();
        }
        self
    }

    /// The group as read. A field of the wrong type (a newer build's value) reads as its
    /// default and stays in the row.
    fn from_group(group: &Map<String, Value>) -> Self {
        let defaults = Self::default();
        let stored_key = group
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = |field: &str, fallback: String| {
            group
                .get(field)
                .and_then(Value::as_str)
                .map_or(fallback, str::to_owned)
        };
        Self {
            enabled: group
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.enabled),
            provider: group
                .get("provider")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or(defaults.provider),
            model: text("model", defaults.model),
            api_key: stored_key.to_owned(),
            base_url: text("baseUrl", defaults.base_url),
        }
    }
}

/// A partial write (`Partial<AIInlineSettings>`). An `api_key` of [`MASKED_KEY`] is ignored,
/// the empty string deletes the stored key, any other value replaces it.
#[derive(Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InlineAiUpdates {
    #[serde(default)]
    #[specta(optional)]
    pub enabled: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub provider: Option<AiProvider>,
    #[serde(default)]
    #[specta(optional)]
    pub model: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub api_key: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub base_url: Option<String>,
}

impl std::fmt::Debug for InlineAiUpdates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InlineAiUpdates")
            .field("enabled", &self.enabled)
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("base_url", &self.base_url.as_deref().map(url_host))
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AiSettingsError {
    #[error("no vault is open")]
    NoVault,
    #[error(transparent)]
    Settings(#[from] SettingsError),
    /// The keychain refused or could not be reached. Nothing was written. A read that only
    /// shows the key (masked) or a write that leaves it alone never fails with this.
    #[error("the AI API key could not be read or saved in the keychain: {0}")]
    Keychain(SecureStoreError),
}

/// The one owner of the inline AI settings and key. Readers in Rust (the provider proxy, the
/// structured calls) take [`InlineAiStore::read`]; the renderer gets [`InlineAiStore::masked`].
/// Ollama takes no key, so its `read` never asks the keychain.
pub struct InlineAiStore {
    settings: SettingsService,
    secrets: Arc<dyn GenericSecrets>,
    device: Option<String>,
    /// The key of the open vault, read from the keychain once per session.
    key: CachedKey,
    /// Serializes the read-migrate and write paths, so a migration never races a key write.
    write: Mutex<()>,
}

impl InlineAiStore {
    /// `device` is the `MEMRY_DEVICE` value.
    pub fn new(
        settings: SettingsService,
        secrets: Arc<dyn GenericSecrets>,
        device: Option<String>,
    ) -> Self {
        Self {
            settings,
            key: CachedKey::new(secrets.clone(), SERVICE, "AI API key"),
            secrets,
            device,
            write: Mutex::new(()),
        }
    }

    /// `api-key:<vault id>` with the device suffix of the sync entries (`-<MEMRY_DEVICE>`, one
    /// `-dev` for every dev worktree).
    pub fn account(&self, vault_id: &str) -> String {
        device_account(&format!("api-key:{vault_id}"), self.device.as_deref())
    }

    /// The settings with the key, for Rust callers only. The defaults while no vault is open. A
    /// key behind a locked keychain is an error; Ollama's read never asks.
    pub fn read(&self, vault: Option<&OpenVault>) -> Result<InlineAiSettings, AiSettingsError> {
        let Some(vault) = vault else {
            return Ok(InlineAiSettings::default());
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let mut settings = self.read_row(vault)?;
        if settings.api_key.is_empty() && settings.provider.takes_key() {
            settings.api_key = self
                .stored_key(&vault.vault_id)?
                .map_or_else(String::new, |key| String::clone(&key));
        }
        Ok(settings)
    }

    /// The renderer's copy of [`InlineAiStore::read`].
    pub fn masked(&self, vault: Option<&OpenVault>) -> Result<InlineAiSettings, AiSettingsError> {
        let Some(vault) = vault else {
            return Ok(InlineAiSettings::default());
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        self.masked_locked(vault)
    }

    /// Applies `updates` and returns the masked result. The key goes to the keychain first; when
    /// that fails nothing is written.
    pub fn write(
        &self,
        vault: Option<&OpenVault>,
        updates: InlineAiUpdates,
    ) -> Result<InlineAiSettings, AiSettingsError> {
        let vault = vault.ok_or(AiSettingsError::NoVault)?;
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        self.read_row(vault)?;

        let mut patch = Map::new();
        if let Some(enabled) = updates.enabled {
            patch.insert("enabled".into(), Value::Bool(enabled));
        }
        if let Some(provider) = updates.provider {
            patch.insert("provider".into(), serde_json::json!(provider));
        }
        if let Some(model) = updates.model {
            patch.insert("model".into(), Value::String(model));
        }
        if let Some(base_url) = updates.base_url {
            patch.insert("baseUrl".into(), Value::String(base_url));
        }
        if let Some(key) = updates.api_key.filter(|key| key != MASKED_KEY) {
            let key = Some(Zeroizing::new(key)).filter(|key| !key.is_empty());
            self.key
                .set(&self.account(&vault.vault_id), key)
                .map_err(AiSettingsError::Keychain)?;
            patch.insert("apiKey".into(), Value::String(String::new()));
        }
        if !patch.is_empty() {
            self.settings.write_secret_group(vault, GROUP, patch)?;
        }
        self.masked_locked(vault)
    }

    /// Drops the cached key; called when the vault closes.
    pub fn forget(&self) {
        self.key.forget();
    }

    /// A keychain that cannot answer (locked or failing) leaves the key unknown, not absent: it
    /// shows masked, so a renderer that sends the masked value back leaves the key alone. The
    /// calls that need the key itself go through [`InlineAiStore::read`] and report the error.
    fn masked_locked(&self, vault: &OpenVault) -> Result<InlineAiSettings, AiSettingsError> {
        let mut settings = self.read_row(vault)?;
        if settings.api_key.is_empty() {
            match self.stored_key(&vault.vault_id) {
                Ok(key) if key.is_some() => settings.api_key = MASKED_KEY.to_owned(),
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        scope = SCOPE,
                        vault_id = %vault.vault_id,
                        "the inline AI key shows as unknown: {error}"
                    );
                    settings.api_key = MASKED_KEY.to_owned();
                }
            }
        }
        Ok(settings.masked())
    }

    /// The row's settings. `api_key` is a plaintext key the row still holds, else empty.
    fn read_row(&self, vault: &OpenVault) -> Result<InlineAiSettings, AiSettingsError> {
        let group = self.settings.read_secret_group(vault, GROUP)?;
        let settings = InlineAiSettings::from_group(&group);
        if settings.api_key.is_empty() {
            return Ok(settings);
        }
        // A plaintext key in the row: move it, or use it for this session.
        let plaintext = Zeroizing::new(settings.api_key.clone());
        match self.migrate(vault, &plaintext) {
            Ok(()) => tracing::info!(
                scope = SCOPE,
                vault_id = %vault.vault_id,
                "moved the inline AI key from the settings row into the keychain"
            ),
            Err(error) => tracing::warn!(
                scope = SCOPE,
                vault_id = %vault.vault_id,
                "the inline AI key stays in the settings row until the keychain can take it: {error}"
            ),
        }
        Ok(settings)
    }

    /// Writes the key, reads it back, and empties the row only when both agree and the row still
    /// holds the key that was moved.
    fn migrate(&self, vault: &OpenVault, plaintext: &Zeroizing<String>) -> Result<(), String> {
        let account = self.account(&vault.vault_id);
        self.secrets
            .set_secret(SERVICE, &account, plaintext.as_bytes())
            .map_err(|error| error.to_string())?;
        let back = self
            .secrets
            .get_secret(SERVICE, &account)
            .map_err(|error| error.to_string())?
            .map(Zeroizing::new);
        if back.as_deref().map(Vec::as_slice) != Some(plaintext.as_bytes()) {
            return Err("the keychain did not return the key it was given".to_owned());
        }
        self.key.remember(&account, Some(plaintext.clone()));
        let row = self
            .settings
            .read_secret_group(vault, GROUP)
            .map_err(|error| error.to_string())?;
        if row.get("apiKey").and_then(Value::as_str) != Some(plaintext.as_str()) {
            return Err("the settings row changed while its key moved".to_owned());
        }
        let patch = Map::from_iter([("apiKey".to_owned(), Value::String(String::new()))]);
        self.settings
            .write_secret_group(vault, GROUP, patch)
            .map_err(|error| error.to_string())
    }

    fn stored_key(&self, vault_id: &str) -> Result<Option<Zeroizing<String>>, AiSettingsError> {
        self.key
            .get(&self.account(vault_id))
            .map_err(AiSettingsError::Keychain)
    }
}
