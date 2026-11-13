//! The inline AI providers (`ai-llm-service.ts:12-46` of Electron): where each one lives and how
//! it is authenticated. Only Rust holds a provider key. The renderer names a host only for Ollama
//! and the custom endpoint, whose URL the user types.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

/// `AIInlineSettings['provider']` of `@memry/contracts/ai-inline-channels`. `Custom` is any
/// OpenAI-compatible endpoint at the stored `baseUrl`, such as OpenRouter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Ollama,
    Openai,
    Anthropic,
    Google,
    Custom,
}

/// The Ollama endpoint of an empty `baseUrl` (`AI_INLINE_SETTINGS_DEFAULTS`).
pub const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

/// The `anthropic-version` header the Anthropic API requires on every request.
const ANTHROPIC_VERSION: &str = "2023-06-01";

impl AiProvider {
    /// The name in user-visible messages (`providerName` of `writing-tools-handlers.ts`): a
    /// custom endpoint is named by the host of `stored`, the one name the user typed.
    pub fn name(self, stored: &str) -> String {
        match self {
            Self::Ollama => "Ollama".to_owned(),
            Self::Openai => "OpenAI".to_owned(),
            Self::Anthropic => "Anthropic".to_owned(),
            Self::Google => "Google".to_owned(),
            Self::Custom => url_host(stored).unwrap_or_else(|| "Custom".to_owned()),
        }
    }

    /// Whether a stored key goes with requests. Ollama never takes one.
    pub fn takes_key(self) -> bool {
        self != Self::Ollama
    }

    /// Whether requests fail without a stored key. A custom endpoint may run without one.
    pub fn needs_key(self) -> bool {
        !matches!(self, Self::Ollama | Self::Custom)
    }

    /// The stored key that goes with this provider at `stored` (#4451): one per cloud provider,
    /// one per origin of a custom endpoint (`custom:https://host[:port]`, normalized as the URL
    /// standard serializes origins), and none for Ollama or a custom endpoint whose URL does not
    /// parse. So a key never follows a selection change to another provider or host.
    pub fn key_slot(self, stored: &str) -> Option<String> {
        Some(match self {
            Self::Ollama => return None,
            Self::Openai => "openai".to_owned(),
            Self::Anthropic => "anthropic".to_owned(),
            Self::Google => "google".to_owned(),
            Self::Custom => {
                let origin = parse_base(stored).ok()?.origin().ascii_serialization();
                format!("custom:{origin}")
            }
        })
    }

    /// The API root, without a trailing slash; `None` for a custom endpoint with no URL. Only
    /// Ollama and the custom endpoint take the stored `baseUrl`; the others are fixed, so a
    /// settings row cannot send their key to another host.
    pub fn base_url(self, stored: &str) -> Option<String> {
        let stored = stored.trim().trim_end_matches('/');
        Some(match self {
            Self::Ollama if stored.is_empty() => OLLAMA_DEFAULT_BASE_URL.to_owned(),
            Self::Custom if stored.is_empty() => return None,
            Self::Ollama | Self::Custom => stored.to_owned(),
            Self::Openai => "https://api.openai.com/v1".to_owned(),
            Self::Anthropic => "https://api.anthropic.com/v1".to_owned(),
            Self::Google => "https://generativelanguage.googleapis.com/v1beta".to_owned(),
        })
    }

    /// The headers that authenticate a request: `authorization: Bearer` for OpenAI and a custom
    /// endpoint, `x-api-key` (and the API version) for Anthropic, `x-goog-api-key` for Google,
    /// nothing for Ollama.
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
            Self::Openai | Self::Custom => ("authorization", format!("Bearer {key}")),
            Self::Anthropic => ("x-api-key", key.to_owned()),
            Self::Google => ("x-goog-api-key", key.to_owned()),
        };
        let mut value = HeaderValue::from_str(&value).map_err(|_| InvalidKey)?;
        value.set_sensitive(true);
        headers.insert(HeaderName::from_static(name), value);
        Ok(headers)
    }
}

/// The host of `url` with its port when the URL names one, as `URL.host` gives it in JavaScript
/// (`localhost:8080`). Never the URL itself, which may carry credentials the user pasted in.
pub fn url_host(url: &str) -> Option<String> {
    let url = reqwest::Url::parse(url.trim()).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// Why a provider address is refused before any request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BadAddress {
    #[error("the address is not a valid URL")]
    NotAUrl,
    /// Electron's `fetch` refuses such a URL ("Request cannot be constructed from a URL that
    /// includes credentials"); reqwest would send them as Basic auth.
    #[error("the address must not contain a user name or password")]
    Credentials,
}

/// `base` parsed as an `http` or `https` URL without credentials.
pub fn parse_base(base: &str) -> Result<reqwest::Url, BadAddress> {
    let url = reqwest::Url::parse(base.trim()).map_err(|_| BadAddress::NotAUrl)?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err(BadAddress::NotAUrl);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(BadAddress::Credentials);
    }
    Ok(url)
}

/// The stored key holds characters no HTTP header can carry. The key itself is never shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the stored API key contains characters that cannot be sent")]
pub struct InvalidKey;
