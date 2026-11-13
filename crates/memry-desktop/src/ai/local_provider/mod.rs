//! The local agent provider settings (`local-provider-settings.ts` and
//! `local-provider-keychain.ts` of Electron): an OpenAI-compatible server the built-in agent
//! talks to, with its optional API key in the OS keychain.
//!
//! The non-secret fields stay in `agent.localProvider` of `memry-config.json`, the object
//! Electron wrote (`{preset, baseUrl, model, allowNonLoopback, thinking?}`); a write edits only
//! the fields it names, so a key a newer build adds survives. The key lives under [`SERVICE`] /
//! `api-key` with the device suffix of the sync entries, never in the config file. Electron's
//! `memry.agent.local-provider` entry is Step 37's read-only import.

pub mod probe;

use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::errors::SecureStoreError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use url::Url;
use zeroize::Zeroizing;

use crate::ai::cached_key::CachedKey;
use crate::registry::{AppConfig, ConfigError};
use crate::seams::secure_store::{GenericSecrets, device_account};

/// The keychain service of the local provider key.
pub const SERVICE: &str = "com.memrynote.memry.agent.local-provider";
/// The `agent` key of the app config that holds the settings.
const CONFIG_KEY: &str = "localProvider";
const SCOPE: &str = "AgentLocalProvider";

/// `AgentLocalProviderPreset`. A preset a newer build adds reads as `custom`, which keeps its
/// stored URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentLocalProviderPreset {
    Ollama,
    LmStudio,
    LlamaCpp,
    Custom,
}

impl AgentLocalProviderPreset {
    /// `LOCAL_PROVIDER_PRESETS`: the base URL of an unset `baseUrl`. `custom` starts at Ollama's.
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Ollama | Self::Custom => "http://localhost:11434/v1",
            Self::LmStudio => "http://localhost:1234/v1",
            Self::LlamaCpp => "http://127.0.0.1:8080/v1",
        }
    }
}

/// `AgentLocalThinking`: `off` asks a thinking model to answer without thinking.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentLocalThinking {
    #[default]
    Default,
    Off,
}

/// `AgentLocalProviderSettings`, the renderer's copy: whether a key is stored, never the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalProviderSettings {
    pub preset: AgentLocalProviderPreset,
    pub base_url: String,
    pub model: String,
    pub api_key_configured: bool,
    pub allow_non_loopback: bool,
    pub thinking: AgentLocalThinking,
}

/// `AgentLocalProviderSettingsUpdate`. `api_key`: absent keeps the stored key, `null` or the
/// empty string deletes it, any other value replaces it. `clear_api_key` deletes it too.
/// `thinking` absent keeps the stored value.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocalProviderSettingsUpdate {
    pub preset: AgentLocalProviderPreset,
    pub base_url: String,
    pub model: String,
    pub allow_non_loopback: bool,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub api_key: Option<Option<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub clear_api_key: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub thinking: Option<AgentLocalThinking>,
}

/// A field that is present, `null` included, is `Some`; an absent one stays `None`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl std::fmt::Debug for AgentLocalProviderSettingsUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentLocalProviderSettingsUpdate")
            .field("preset", &self.preset)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("allow_non_loopback", &self.allow_non_loopback)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("clear_api_key", &self.clear_api_key)
            .field("thinking", &self.thinking)
            .finish()
    }
}

/// The settings with the key, for Rust callers only (the probe, the agent engine).
#[derive(Clone)]
pub struct LocalProvider {
    pub preset: AgentLocalProviderPreset,
    pub base_url: String,
    pub model: String,
    pub allow_non_loopback: bool,
    pub thinking: AgentLocalThinking,
    pub api_key: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for LocalProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalProvider")
            .field("preset", &self.preset)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("allow_non_loopback", &self.allow_non_loopback)
            .field("thinking", &self.thinking)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl LocalProvider {
    /// The base URL requests go to. A non-loopback URL the user did not confirm is refused
    /// here too, so a hand-edited config cannot send the key to another host unasked.
    pub fn endpoint(&self) -> Result<&str, LocalProviderError> {
        check_base_url(&self.base_url, self.allow_non_loopback)?;
        Ok(self.base_url.trim_end_matches('/'))
    }

    pub fn key(&self) -> Option<&str> {
        self.api_key.as_deref().map(String::as_str)
    }

    /// `text` with the key replaced: a provider may echo the authorization header in its error
    /// body. Redact the whole text before clipping it, or a clipped key prefix gets through.
    pub fn redact(&self, text: String) -> String {
        match self.key() {
            Some(key) if !key.is_empty() => text.replace(key, "[key]"),
            _ => text,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LocalProviderError {
    /// The URL itself is left out: it can carry a user name and password.
    #[error("the base URL is not an http or https URL")]
    InvalidUrl,
    #[error("Non-loopback local provider endpoints require explicit confirmation.")]
    NonLoopback,
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// The keychain refused or could not be reached. Nothing was written.
    #[error("the local provider API key could not be read or saved in the keychain: {0}")]
    Keychain(SecureStoreError),
}

/// `isLoopbackBaseUrl`: `localhost`, `127.0.0.1` or `::1`.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    }
}

fn check_base_url(base_url: &str, allow_non_loopback: bool) -> Result<(), LocalProviderError> {
    let url = Url::parse(base_url.trim())
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or(LocalProviderError::InvalidUrl)?;
    if !allow_non_loopback && !is_loopback(&url) {
        return Err(LocalProviderError::NonLoopback);
    }
    Ok(())
}

/// The stored fields, with Electron's defaults for absent ones. A field of the wrong type (a
/// newer build's value) reads as its default and stays in the config.
fn from_config(stored: Option<&Map<String, Value>>) -> LocalProvider {
    let field = |name: &str| stored.and_then(|map| map.get(name));
    let preset = field("preset").map_or(AgentLocalProviderPreset::Ollama, |value| {
        serde_json::from_value(value.clone()).unwrap_or(AgentLocalProviderPreset::Custom)
    });
    let text = |name: &str| field(name).and_then(Value::as_str).map(str::to_owned);
    LocalProvider {
        preset,
        base_url: text("baseUrl").unwrap_or_else(|| preset.default_base_url().to_owned()),
        model: text("model").unwrap_or_default(),
        allow_non_loopback: field("allowNonLoopback")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        thinking: field("thinking")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default(),
        api_key: None,
    }
}

/// The one owner of the local provider settings and key. The key is read from the keychain once
/// per process and kept until a write.
pub struct LocalProviderStore {
    config: Arc<AppConfig>,
    key: CachedKey,
    account: String,
    /// Serializes writes, so two never merge into the config from the same stale copy.
    write: Mutex<()>,
}

impl LocalProviderStore {
    /// `device` is the `MEMRY_DEVICE` value.
    pub fn new(
        config: Arc<AppConfig>,
        secrets: Arc<dyn GenericSecrets>,
        device: Option<&str>,
    ) -> Self {
        Self {
            config,
            key: CachedKey::new(secrets, SERVICE, "local provider API key"),
            account: device_account("api-key", device),
            write: Mutex::new(()),
        }
    }

    /// The keychain account: `api-key` with the device suffix rule of the sync entries.
    pub fn account(&self) -> &str {
        &self.account
    }

    /// The settings with the key, for Rust callers only. A keychain that cannot answer gives the
    /// settings without a key, and its error for the caller to show: a keyless server still
    /// works, and one that needs the key answers 401.
    pub fn read(&self) -> (LocalProvider, Option<SecureStoreError>) {
        let mut provider = self.stored();
        match self.key.get(&self.account) {
            Ok(key) => {
                provider.api_key = key;
                (provider, None)
            }
            Err(error) => (provider, Some(error)),
        }
    }

    /// The renderer's copy. A keychain that cannot answer leaves the key unknown, which shows as
    /// configured: a renderer that sends no key back leaves it alone either way.
    pub fn settings(&self) -> AgentLocalProviderSettings {
        let configured = match self.key.get(&self.account) {
            Ok(key) => key.is_some(),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "the local provider key shows as unknown: {error}"
                );
                true
            }
        };
        let provider = self.stored();
        AgentLocalProviderSettings {
            preset: provider.preset,
            base_url: provider.base_url,
            model: provider.model,
            api_key_configured: configured,
            allow_non_loopback: provider.allow_non_loopback,
            thinking: provider.thinking,
        }
    }

    /// Applies `update` and returns the renderer's copy. The URL gate runs first and the key goes
    /// to the keychain before the config, so a refused update writes nothing.
    pub fn write(
        &self,
        update: AgentLocalProviderSettingsUpdate,
    ) -> Result<AgentLocalProviderSettings, LocalProviderError> {
        check_base_url(&update.base_url, update.allow_non_loopback)?;
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let key = if update.clear_api_key == Some(true) {
            Some(None)
        } else {
            update.api_key.map(|key| key.filter(|key| !key.is_empty()))
        };
        if let Some(key) = key {
            self.key
                .set(&self.account, key.map(Zeroizing::new))
                .map_err(LocalProviderError::Keychain)?;
        }
        let mut patch = Map::new();
        patch.insert("preset".into(), serde_json::json!(update.preset));
        patch.insert("baseUrl".into(), Value::String(update.base_url));
        patch.insert("model".into(), Value::String(update.model));
        patch.insert(
            "allowNonLoopback".into(),
            Value::Bool(update.allow_non_loopback),
        );
        if let Some(thinking) = update.thinking {
            patch.insert("thinking".into(), serde_json::json!(thinking));
        }
        let mut stored = self.config.agent().local_provider.unwrap_or_default();
        stored.extend(patch);
        self.config
            .set_agent_field(CONFIG_KEY, Some(Value::Object(stored)))?;
        Ok(self.settings())
    }

    fn stored(&self) -> LocalProvider {
        from_config(self.config.agent().local_provider.as_ref())
    }
}
