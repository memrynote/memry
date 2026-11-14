//! The wire types of a provider request and the checks that turn one into an upstream call:
//! the path stays under the provider's base, the renderer's auth headers are dropped and the
//! stored key's auth is added.

use reqwest::Url;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::ai::provider::{AiProvider, parse_base};
use crate::ai::settings::InlineAiSettings;

/// The largest request body, the inline chat server's ceiling (`ai-chat-server.ts:19`).
pub const BODY_CAP: usize = 25 * 1024 * 1024;

/// Request headers the renderer may not set: the provider auth Rust adds, the host, the framing
/// reqwest owns, and `accept-encoding`, because the body is passed through undecoded.
const DROPPED_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "host",
    "cookie",
    "content-length",
    "transfer-encoding",
    "connection",
    "accept-encoding",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

/// One provider call of the renderer's AI SDK. `path` is relative to the provider's base URL
/// and may carry a query (`?alt=sse`).
#[derive(Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderRequest {
    pub request_id: String,
    pub provider: AiProvider,
    pub method: HttpMethod,
    pub path: String,
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
}

impl std::fmt::Debug for AiProviderRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiProviderRequest")
            .field("request_id", &self.request_id)
            .field("provider", &self.provider)
            .field("method", &self.method)
            .field("path", &self.path)
            .field("body_len", &self.body.as_ref().map(String::len))
            .finish_non_exhaustive()
    }
}

/// The provider's status and headers.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderHead {
    pub status: u16,
    pub headers: Vec<HeaderPair>,
}

/// One message of the body channel. On the wire a tag byte leads: `0` and the bytes of a
/// chunk, `1` for the end, `2` and a UTF-8 message for a body that broke off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Data(Vec<u8>),
    End,
    Failed(String),
}

impl Frame {
    pub fn encode(self) -> Vec<u8> {
        let (tag, payload) = match self {
            Self::Data(bytes) => (0, bytes),
            Self::End => (1, Vec::new()),
            Self::Failed(message) => (2, message.into_bytes()),
        };
        let mut out = Vec::with_capacity(payload.len() + 1);
        out.push(tag);
        out.extend_from_slice(&payload);
        out
    }
}

/// Takes each frame; `false` means the renderer is gone and the request ends.
pub type Sink = Box<dyn FnMut(Frame) -> bool + Send>;

/// Why a request got no head. No message carries the key; provider failures name the provider.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProxyError {
    #[error("{0}")]
    Invalid(String),
    #[error("inline AI is turned off")]
    Disabled,
    #[error("the AI provider changed while the request was prepared")]
    ProviderChanged,
    #[error("no {provider} API key is stored")]
    KeyMissing { provider: String },
    #[error("the request body is larger than 25 MiB")]
    TooLarge,
    #[error("{provider} could not be reached")]
    Unreachable { provider: String },
    #[error("the request was cancelled")]
    Cancelled,
    #[error("the vault closed")]
    VaultClosed,
    /// [`AiProxy::call`] only: the answer passed its cap.
    #[error("{provider} sent an answer larger than {cap} bytes")]
    AnswerTooLarge { provider: String, cap: usize },
    /// [`AiProxy::call`] only: the body broke off, with the frame's message.
    #[error("{0}")]
    BrokeOff(String),
}

/// Where a request goes and with which headers, the key among them.
pub struct Prepared {
    pub url: Url,
    pub headers: HeaderMap,
    /// The provider's name in messages.
    pub name: String,
}

/// Checks `request` against `settings` and resolves it: the provider's base plus the path, the
/// renderer's headers less [`DROPPED_HEADERS`], and the provider's auth from the stored key.
pub fn prepare(
    settings: &InlineAiSettings,
    request: &AiProviderRequest,
) -> Result<Prepared, ProxyError> {
    if !settings.enabled {
        return Err(ProxyError::Disabled);
    }
    if request.provider != settings.provider {
        return Err(ProxyError::ProviderChanged);
    }
    let provider = settings.provider;
    let name = provider.name(&settings.base_url);
    let base = provider
        .base_url(&settings.base_url)
        .ok_or_else(|| ProxyError::Invalid("Custom provider URL required".to_owned()))?;
    let url = target(&base, &request.path)?;
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > BODY_CAP)
    {
        return Err(ProxyError::TooLarge);
    }
    let key = provider
        .takes_key()
        .then_some(settings.api_key.as_str())
        .filter(|key| !key.is_empty());
    if provider.needs_key() && key.is_none() {
        return Err(ProxyError::KeyMissing { provider: name });
    }
    let mut headers = renderer_headers(&request.headers)?;
    let auth = provider
        .auth_headers(key)
        .map_err(|error| ProxyError::Invalid(error.to_string()))?;
    for (header, value) in &auth {
        headers.insert(header.clone(), value.clone());
    }
    Ok(Prepared { url, headers, name })
}

/// `base` + `path`, refused unless it stays under `base`. `path` starts with `/`; the part
/// before `?` holds no `..`, `//`, backslash or scheme, and nothing holds a control character
/// or a fragment.
pub fn target(base: &str, path: &str) -> Result<Url, ProxyError> {
    let invalid = |why: &str| ProxyError::Invalid(format!("the provider path {why}"));
    if !path.starts_with('/') {
        return Err(invalid("must start with /"));
    }
    if path.chars().any(|c| c.is_control() || c == '#') {
        return Err(invalid("holds a control character or a fragment"));
    }
    let route = path.split_once('?').map_or(path, |(route, _)| route);
    if route.contains("..") || route.contains("//") || route.contains('\\') || route.contains("://")
    {
        return Err(invalid("must stay under the provider's address"));
    }
    let base = parse_base(base).map_err(|error| ProxyError::Invalid(error.to_string()))?;
    let root = base.path().trim_end_matches('/');
    let url = Url::parse(&format!("{}{path}", base.as_str().trim_end_matches('/')))
        .map_err(|_| invalid("is not a valid URL"))?;
    let under = url
        .path()
        .strip_prefix(root)
        .is_some_and(|rest| rest.starts_with('/'));
    if url.origin() != base.origin() || !under {
        return Err(invalid("must stay under the provider's address"));
    }
    Ok(url)
}

/// The renderer's headers less [`DROPPED_HEADERS`]. A name or value no HTTP request can carry
/// is refused.
fn renderer_headers(pairs: &[HeaderPair]) -> Result<HeaderMap, ProxyError> {
    let mut headers = HeaderMap::new();
    for pair in pairs {
        let name = HeaderName::from_bytes(pair.name.as_bytes())
            .map_err(|_| ProxyError::Invalid("a request header name is not valid".to_owned()))?;
        if DROPPED_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(&pair.value)
            .map_err(|_| ProxyError::Invalid(format!("the {name} header is not valid")))?;
        headers.append(name, value);
    }
    Ok(headers)
}

/// The provider's headers less `set-cookie`, each value that is text.
pub(super) fn response_headers(headers: &HeaderMap) -> Vec<HeaderPair> {
    headers
        .iter()
        .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
        .filter_map(|(name, value)| {
            Some(HeaderPair {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect()
}
