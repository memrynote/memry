//! The model list and the connection test of the inline AI settings screen. Electron listed
//! Ollama's models (`ai-inline-handlers.ts:134-155`) and "tested" by starting its localhost chat
//! server; with that server gone, the test asks the provider itself (`GET <base>/models`).

use std::time::Duration;

use serde::Deserialize;

use super::provider::AiProvider;
use super::settings::InlineAiSettings;
use crate::http::read_capped;

/// The Ollama model list waits this long (issue #3539).
pub const OLLAMA_TIMEOUT: Duration = Duration::from_secs(5);
/// A cloud provider's model list waits this long.
pub const PROVIDER_TIMEOUT: Duration = Duration::from_secs(10);
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

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: Option<String>,
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
/// 2xx is returned.
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
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let response = client
        .0
        .get(&url)
        .headers(headers)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| classify_send(provider, &error))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProbeFailure::Unauthorized);
    }
    if !status.is_success() {
        return Err(ProbeFailure::Other(format!(
            "{} answered {}",
            provider.label(),
            status.as_u16()
        )));
    }
    read_capped(response, BODY_CAP)
        .await
        .map_err(|error| ProbeFailure::Other(format!("{}: {error}", provider.label())))
}

/// A request that got no status. A URL that cannot be built is a settings problem, not an
/// unreachable host.
fn classify_send(provider: AiProvider, error: &reqwest::Error) -> ProbeFailure {
    if error.is_builder() {
        return ProbeFailure::Other(format!(
            "{}: the address is not a valid URL",
            provider.label()
        ));
    }
    ProbeFailure::Unreachable
}

/// The model ids of the Ollama at `base_url` (OpenAI dialect, `{ data: [{ id }] }`).
pub async fn list_ollama_models(
    client: &ProbeClient,
    base_url: &str,
) -> Result<Vec<String>, ProbeFailure> {
    let base = AiProvider::Ollama.base_url(base_url);
    let body = probe(client, AiProvider::Ollama, &base, None, OLLAMA_TIMEOUT).await?;
    let list: ModelList = serde_json::from_slice(&body)
        .map_err(|_| ProbeFailure::Other("Ollama answered with an unreadable model list".into()))?;
    Ok(list
        .data
        .into_iter()
        .filter_map(|entry| entry.id.filter(|id| !id.is_empty()))
        .collect())
}

/// Whether `settings` (with its key) can reach the provider: Ollama lists its models, the
/// others answer `GET /models`.
pub async fn test_connection(
    client: &ProbeClient,
    settings: &InlineAiSettings,
) -> Result<(), ProbeFailure> {
    if settings.provider == AiProvider::Ollama {
        return list_ollama_models(client, &settings.base_url)
            .await
            .map(|_| ());
    }
    let base = settings.provider.base_url(&settings.base_url);
    probe(
        client,
        settings.provider,
        &base,
        Some(&settings.api_key),
        PROVIDER_TIMEOUT,
    )
    .await
    .map(|_| ())
}
