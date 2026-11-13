//! The inline AI settings of a vault (`ai-inline-handlers.ts` of Electron) with the API keys in
//! the OS keychain.
//!
//! The non-secret fields stay in the vault's `ai-inline` local settings group, the same JSON
//! Electron wrote (`{enabled, provider, model, apiKey, baseUrl}`), with `apiKey` always empty
//! when this build writes it. Each key belongs to one provider, and a custom endpoint's key to
//! one origin (#4451): it lives under [`SERVICE`] / [`InlineAiStore::key_account`], so a change of
//! provider or custom URL never sends a key to another provider or host.
//!
//! Compatibility contract (existing installs and rows):
//! - A row that still carries a key (Electron's plaintext, or one imported from it, Step 37) moves
//!   into the key of the provider and origin the row selects when it is read: written, read
//!   back, compared, and only then emptied in the row. Rows with a plaintext `apiKey` stay
//!   readable forever.
//! - The single key of builds before #4451 ([`InlineAiStore::legacy_account`]) moves once, at the
//!   first read, to the selection of that read; the row's `apiKeyPerProvider: true` records the
//!   move. A selection that takes no key (Ollama, a custom endpoint without a valid URL) binds it
//!   nowhere. The legacy entry is left in place and stays readable.
//! - Until a key can move (a locked keychain), the key is never used and a change of provider or
//!   URL is refused, so the key cannot follow the change.

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
    /// A key typed while the selection names no provider or endpoint to hold it: Ollama, or a
    /// custom endpoint without a valid `http(s)` URL.
    #[error("enter the endpoint URL before its API key")]
    NoKeyTarget,
}

/// The row field that records the one-time move of the legacy key. Older builds ignore it and
/// keep it on write.
const BOUND: &str = "apiKeyPerProvider";

/// The row as settled: the settings with `api_key` empty, the account of the selected
/// provider's key, and why a key in the row or the legacy entry has not moved yet.
struct Settled {
    settings: InlineAiSettings,
    account: Option<String>,
    pending: Option<SecureStoreError>,
}

/// The one owner of the inline AI settings and keys. Readers in Rust (the provider proxy, the
/// model list, the structured calls) take [`InlineAiStore::read`]; the renderer gets
/// [`InlineAiStore::masked`]. Ollama takes no key, so its `read` never asks the keychain.
pub struct InlineAiStore {
    settings: SettingsService,
    secrets: Arc<dyn GenericSecrets>,
    device: Option<String>,
    /// The key last read or written, kept until a write.
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

    /// The account of the key `provider` takes at `base_url`: `api-key:<vault id>:<slot>` with
    /// the slot of [`AiProvider::key_slot`] and the device suffix of the sync entries
    /// (`-<MEMRY_DEVICE>`, one `-dev` for every dev worktree). `None` when it takes no key.
    pub fn key_account(
        &self,
        vault_id: &str,
        provider: AiProvider,
        base_url: &str,
    ) -> Option<String> {
        let slot = provider.key_slot(base_url)?;
        Some(device_account(
            &format!("api-key:{vault_id}:{slot}"),
            self.device.as_deref(),
        ))
    }

    /// The single key of builds before #4451, `api-key:<vault id>` with the device suffix. Read
    /// once by the move and by the Electron import (Step 37); never written by a key edit.
    pub fn legacy_account(&self, vault_id: &str) -> String {
        device_account(&format!("api-key:{vault_id}"), self.device.as_deref())
    }

    /// The settings with the selected provider's key, for Rust callers only. The defaults while
    /// no vault is open. A key behind a locked keychain is an error; Ollama's read never asks.
    pub fn read(&self, vault: Option<&OpenVault>) -> Result<InlineAiSettings, AiSettingsError> {
        let Some(vault) = vault else {
            return Ok(InlineAiSettings::default());
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let Settled {
            mut settings,
            account,
            pending,
        } = self.settle(vault)?;
        let Some(account) = account else {
            return Ok(settings);
        };
        if let Some(error) = pending {
            return Err(AiSettingsError::Keychain(error));
        }
        settings.api_key = self
            .key
            .get(&account)
            .map_err(AiSettingsError::Keychain)?
            .map_or_else(String::new, |key| String::clone(&key));
        Ok(settings)
    }

    /// The renderer's copy of [`InlineAiStore::read`]: `apiKey` is [`MASKED_KEY`] when the
    /// selected provider has a key, else empty.
    pub fn masked(&self, vault: Option<&OpenVault>) -> Result<InlineAiSettings, AiSettingsError> {
        let Some(vault) = vault else {
            return Ok(InlineAiSettings::default());
        };
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        self.masked_locked(vault)
    }

    /// Applies `updates` and returns the masked result. A key goes to the provider and origin
    /// the updated selection names, before anything else; when that fails nothing is written.
    pub fn write(
        &self,
        vault: Option<&OpenVault>,
        updates: InlineAiUpdates,
    ) -> Result<InlineAiSettings, AiSettingsError> {
        let vault = vault.ok_or(AiSettingsError::NoVault)?;
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let Settled {
            settings, pending, ..
        } = self.settle(vault)?;
        let key = updates.api_key.filter(|key| key != MASKED_KEY);
        let reselects = updates.provider.is_some() || updates.base_url.is_some();
        if let Some(error) = pending
            && (reselects || key.is_some())
        {
            return Err(AiSettingsError::Keychain(error));
        }
        let provider = updates.provider.unwrap_or(settings.provider);
        let base_url = updates.base_url.as_deref().unwrap_or(&settings.base_url);
        let account = self.key_account(&vault.vault_id, provider, base_url);

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
        if let Some(key) = key {
            let key = Some(Zeroizing::new(key)).filter(|key| !key.is_empty());
            match (account, key) {
                (Some(account), key) => self
                    .key
                    .set(&account, key)
                    .map_err(AiSettingsError::Keychain)?,
                (None, None) => {}
                (None, Some(_)) => return Err(AiSettingsError::NoKeyTarget),
            }
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
        let Settled {
            mut settings,
            account,
            pending,
        } = self.settle(vault)?;
        let Some(account) = account else {
            return Ok(settings);
        };
        let known = match pending {
            Some(error) => Err(error),
            None => self.key.get(&account),
        };
        settings.api_key = match known {
            Ok(Some(_)) => MASKED_KEY.to_owned(),
            Ok(None) => String::new(),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    vault_id = %vault.vault_id,
                    "the inline AI key shows as unknown: {error}"
                );
                MASKED_KEY.to_owned()
            }
        };
        Ok(settings)
    }

    /// Reads the row and moves a key it or the legacy entry still holds to its provider.
    fn settle(&self, vault: &OpenVault) -> Result<Settled, AiSettingsError> {
        let group = self.settings.read_secret_group(vault, GROUP)?;
        let mut settings = InlineAiSettings::from_group(&group);
        let account = self.key_account(&vault.vault_id, settings.provider, &settings.base_url);
        let plaintext = Zeroizing::new(std::mem::take(&mut settings.api_key));
        let pending = if !plaintext.is_empty() {
            self.move_plaintext(vault, account.as_deref(), &plaintext)?
        } else if group.get(BOUND).and_then(Value::as_bool) != Some(true) {
            self.move_legacy(vault, account.as_deref())?
        } else {
            None
        };
        Ok(Settled {
            settings,
            account,
            pending,
        })
    }

    /// Moves the row's plaintext key to `account`, or with no provider to take it into the
    /// legacy entry, where it is kept and never sent. The row is emptied only when the keychain
    /// returned the key and the row still holds it. `Some` is why the key could not move.
    fn move_plaintext(
        &self,
        vault: &OpenVault,
        account: Option<&str>,
        plaintext: &Zeroizing<String>,
    ) -> Result<Option<SecureStoreError>, AiSettingsError> {
        let target = account.map_or_else(|| self.legacy_account(&vault.vault_id), str::to_owned);
        if let Err(error) = self.put_verified(&target, plaintext.as_bytes()) {
            tracing::warn!(
                scope = SCOPE,
                vault_id = %vault.vault_id,
                "the inline AI key stays in the settings row, unused, until the keychain can take it: {error}"
            );
            return Ok(Some(error));
        }
        if account.is_some() {
            self.key.remember(&target, Some(plaintext.clone()));
        }
        let row = self.settings.read_secret_group(vault, GROUP)?;
        if row.get("apiKey").and_then(Value::as_str) != Some(plaintext.as_str()) {
            tracing::warn!(
                scope = SCOPE,
                vault_id = %vault.vault_id,
                "the settings row changed while its key moved; the next read moves the new one"
            );
            return Ok(None);
        }
        let patch = Map::from_iter([
            ("apiKey".to_owned(), Value::String(String::new())),
            (BOUND.to_owned(), Value::Bool(true)),
        ]);
        self.settings.write_secret_group(vault, GROUP, patch)?;
        tracing::info!(
            scope = SCOPE,
            vault_id = %vault.vault_id,
            "moved the inline AI key from the settings row into the keychain"
        );
        Ok(None)
    }

    /// The one-time move of the legacy key to `account`. With no provider to take it, nothing is
    /// read and the key stays where it is, unused. `Some` is why the key could not move.
    fn move_legacy(
        &self,
        vault: &OpenVault,
        account: Option<&str>,
    ) -> Result<Option<SecureStoreError>, AiSettingsError> {
        if let Some(account) = account {
            let legacy = self.legacy_account(&vault.vault_id);
            let key = match self.secrets.get_secret(SERVICE, &legacy) {
                Ok(key) => key.map(Zeroizing::new),
                Err(error) => return Ok(Some(error)),
            };
            if let Some(key) = key {
                if let Err(error) = self.put_verified(account, &key) {
                    return Ok(Some(error));
                }
                self.key.forget();
            }
        }
        let patch = Map::from_iter([(BOUND.to_owned(), Value::Bool(true))]);
        self.settings.write_secret_group(vault, GROUP, patch)?;
        Ok(None)
    }

    /// Writes `key` under `account` and reads it back.
    fn put_verified(&self, account: &str, key: &[u8]) -> Result<(), SecureStoreError> {
        self.secrets.set_secret(SERVICE, account, key)?;
        let back = self
            .secrets
            .get_secret(SERVICE, account)?
            .map(Zeroizing::new);
        if back.as_deref().map(Vec::as_slice) != Some(key) {
            return Err(SecureStoreError::Failed {
                what: "the keychain did not return the key it was given".to_owned(),
            });
        }
        Ok(())
    }
}
