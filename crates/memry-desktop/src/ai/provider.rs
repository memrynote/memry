//! The four inline AI providers (`ai-llm-service.ts:12-40` of Electron): where each one lives and
//! how it is authenticated. Only Rust holds a provider key; the renderer never names a host.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

/// `AIInlineSettings['provider']` of `@memry/contracts/ai-inline-channels`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Ollama,
    Openai,
    Anthropic,
    Google,
}

/// The Ollama endpoint of an empty `baseUrl` (`AI_INLINE_SETTINGS_DEFAULTS`).
pub const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

/// The `anthropic-version` header the Anthropic API requires on every request.
const ANTHROPIC_VERSION: &str = "2023-06-01";

impl AiProvider {
    /// The name in user-visible messages (`PROVIDER_NAMES` of `writing-tools-handlers.ts`).
    pub fn label(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Google => "Google",
        }
    }

    /// Whether requests need a stored key. Ollama runs without one.
    pub fn needs_key(self) -> bool {
        self != Self::Ollama
    }

    /// The API root, without a trailing slash. Only Ollama takes the stored `baseUrl`; the
    /// others are fixed, so a settings row cannot send a key to another host.
    pub fn base_url(self, stored: &str) -> String {
        match self {
            Self::Ollama => {
                let stored = stored.trim();
                let base = if stored.is_empty() {
                    OLLAMA_DEFAULT_BASE_URL
                } else {
                    stored
                };
                base.trim_end_matches('/').to_owned()
            }
            Self::Openai => "https://api.openai.com/v1".to_owned(),
            Self::Anthropic => "https://api.anthropic.com/v1".to_owned(),
            Self::Google => "https://generativelanguage.googleapis.com/v1beta".to_owned(),
        }
    }

    /// The headers that authenticate a request: `authorization: Bearer` for OpenAI, `x-api-key`
    /// (and the API version) for Anthropic, `x-goog-api-key` for Google, nothing for Ollama.
    /// A key that is not a valid header value is refused rather than sent.
    pub fn auth_headers(self, key: Option<&str>) -> Result<HeaderMap, InvalidKey> {
        let mut headers = HeaderMap::new();
        if self == Self::Anthropic {
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static(ANTHROPIC_VERSION),
            );
        }
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            return Ok(headers);
        };
        let (name, value) = match self {
            Self::Ollama => return Ok(headers),
            Self::Openai => ("authorization", format!("Bearer {key}")),
            Self::Anthropic => ("x-api-key", key.to_owned()),
            Self::Google => ("x-goog-api-key", key.to_owned()),
        };
        let mut value = HeaderValue::from_str(&value).map_err(|_| InvalidKey)?;
        value.set_sensitive(true);
        headers.insert(HeaderName::from_static(name), value);
        Ok(headers)
    }
}

/// The stored key holds characters no HTTP header can carry. The key itself is never shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the stored API key contains characters that cannot be sent")]
pub struct InvalidKey;
