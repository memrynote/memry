//! The model list and the connection test of the inline AI settings screen. Electron lists the
//! models of the configured endpoint (`ai-inline-handlers.ts:133-157`) and "tested" by starting
//! its localhost chat server; with that server gone, the test asks the provider itself: both are
//! `GET <base>/models` with the provider's authentication.

use std::time::Duration;

use serde::Deserialize;

use super::provider::{AiProvider, BadAddress, parse_base};
use super::settings::InlineAiSettings;
use crate::http::read_capped;

/// The Ollama model list waits this long (issue #3539).
pub const OLLAMA_TIMEOUT: Duration = Duration::from_secs(5);
/// Any other provider's model list waits this long.
pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(10);
/// The page size of Gemini's model list, its maximum: one page holds every model.
const GEMINI_PAGE_SIZE: &str = "1000";
/// The largest model list read. OpenRouter-sized catalogues are a few hundred KiB.
const BODY_CAP: usize = 4 * 1024 * 1024;

/// Why a provider could not be used, classified as `writing-assist.ts:55-62` does: no answer is
/// `Unreachable`, 401 and 403 `Unauthorized`, everything else `Other`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProbeFailure {
    #[error("the provider could not be reached")]
    Unreachable,
    #[error("the provider rejected the API key")]
    Unauthorized,
    #[error("no API key is stored")]
    KeyMissing,
    #[error("{0}")]
    Other(String),
}

/// `{ data: [{ id }] }` of the OpenAI dialect (OpenAI, Anthropic, Ollama, OpenAI-compatible
/// endpoints) or `{ models: [{ name: "models/<id>" }] }` of Gemini.
#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
    #[serde(default)]
    models: Vec<GeminiModel>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: Option<String>,
}

#[derive(Deserialize)]
struct GeminiModel {
    name: Option<String>,
}

impl ModelList {
    fn ids(self) -> Vec<String> {
        let gemini = self.models.into_iter().filter_map(|model| {
            let name = model.name?;
            Some(name.strip_prefix("models/").unwrap_or(&name).to_owned())
        });
        self.data
            .into_iter()
            .filter_map(|entry| entry.id)
            .chain(gemini)
            .filter(|id| !id.is_empty())
            .collect()
    }
}

/// The client of every probe: the caller's builder (the shared TLS stack) with redirects off.
/// reqwest keeps `x-api-key` and `x-goog-api-key` across a cross-host redirect, so a redirect is
/// reported as the provider's answer and never followed. The only way to build one is
/// [`ProbeClient::new`], so no probe runs on a client that follows redirects.
pub struct ProbeClient(reqwest::Client);

impl ProbeClient {
    pub fn new(builder: reqwest::ClientBuilder) -> Self {
        Self(
            builder
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("the probe HTTP client needs a process default rustls crypto provider"),
        )
    }
}

/// `GET <base>/models` with the provider's authentication, on a [`ProbeClient`]. The body of a
/// 2xx is returned. No failure carries the key: messages name the provider and the status only.
pub async fn probe(
    client: &ProbeClient,
    provider: AiProvider,
    base_url: &str,
    key: Option<&str>,
    timeout: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    if provider.needs_key() && key.is_none_or(str::is_empty) {
        return Err(ProbeFailure::KeyMissing);
    }
    let headers = provider
        .auth_headers(key)
        .map_err(|error| ProbeFailure::Other(error.to_string()))?;
    let name = provider.name(base_url);
    let mut url = parse_base(&format!("{}/models", base_url.trim_end_matches('/')))
        .map_err(|error| ProbeFailure::Other(format!("{name}: {error}")))?;
    if provider == AiProvider::Google {
        // Gemini pages its model list at 50 by default; 1000 is its maximum.
        url.query_pairs_mut()
            .append_pair("pageSize", GEMINI_PAGE_SIZE);
    }
    let response = client
        .0
        .get(url)
        .headers(headers)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| classify_send(&name, &error))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProbeFailure::Unauthorized);
    }
    if !status.is_success() {
        return Err(ProbeFailure::Other(format!(
            "{name} answered {}",
            status.as_u16()
        )));
    }
    read_capped(response, BODY_CAP)
        .await
        .map_err(|error| ProbeFailure::Other(format!("{name}: {error}")))
}

/// A request that got no status. A URL that cannot be built is a settings problem, not an
/// unreachable host.
fn classify_send(name: &str, error: &reqwest::Error) -> ProbeFailure {
    if error.is_builder() {
        return ProbeFailure::Other(format!("{name}: {}", BadAddress::NotAUrl));
    }
    ProbeFailure::Unreachable
}

/// The model ids of the configured provider (`ai-inline:list-models`), with its key when it
/// takes one. A custom endpoint gets the key only at its own stored URL.
pub async fn list_models(
    client: &ProbeClient,
    settings: &InlineAiSettings,
) -> Result<Vec<String>, ProbeFailure> {
    let provider = settings.provider;
    let base = provider
        .base_url(&settings.base_url)
        .ok_or_else(|| ProbeFailure::Other("Custom provider URL required".to_owned()))?;
    let key = provider.takes_key().then_some(settings.api_key.as_str());
    let timeout = if provider == AiProvider::Ollama {
        OLLAMA_TIMEOUT
    } else {
        PROVIDER_TIMEOUT
    };
    let body = probe(client, provider, &base, key, timeout).await?;
    let list: ModelList = serde_json::from_slice(&body).map_err(|_| {
        ProbeFailure::Other(format!(
            "{} answered with an unreadable model list",
            provider.name(&base)
        ))
    })?;
    Ok(list.ids())
}

/// Whether `settings` (with its key) can reach the provider: it lists the models.
pub async fn test_connection(
    client: &ProbeClient,
    settings: &InlineAiSettings,
) -> Result<(), ProbeFailure> {
    list_models(client, settings).await.map(|_| ())
}
