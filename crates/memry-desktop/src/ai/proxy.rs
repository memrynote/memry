//! The authenticated network of inline chat (Step 22, #3539). The AI SDK runs in the renderer
//! with a dummy base URL and a `fetch` that lands here: the renderer names a provider and a path,
//! Rust resolves the provider's base, adds the stored key and streams the answer back. The key
//! never reaches the webview and no request reaches a host the settings do not name.
//!
//! A request answers with its status and headers; the body follows as [`Frame`]s. The
//! upstream request ends on [`AiProxy::cancel`], when the page that sent it reloads or its
//! window closes ([`AiProxy::cancel_owner`]: a channel to a gone page keeps accepting frames, so
//! the sink cannot tell), when the sink reports the renderer gone, and for every request when
//! the vault closes (the `ai-proxy` close hook).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::provider::{AiProvider, parse_base};
use super::settings::InlineAiSettings;
use crate::session::Session;

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

/// The webview a request belongs to, as its page was when the command began.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    label: String,
    /// The count of [`AiProxy::cancel_owner`] calls for `label` when this was taken.
    generation: u64,
}

/// A whole answer of [`AiProxy::call`].
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<HeaderPair>,
    pub body: Vec<u8>,
}

/// The message of a body the vault's close ended.
const VAULT_CLOSED: &str = "the vault closed";

/// How many ids cancelled before their request opened are remembered.
const EARLY_CANCELS: usize = 64;

/// The in-flight provider requests, each cancellable by its id.
pub struct AiProxy {
    client: reqwest::Client,
    in_flight: Mutex<InFlight>,
}

#[derive(Default)]
struct InFlight {
    running: HashMap<String, Entry>,
    /// Ids cancelled before `open` registered them: the renderer's abort can overtake its
    /// request while Rust still reads the settings. Ids are fresh UUIDs, so the oldest can go.
    early: VecDeque<String>,
    /// How often each page went ([`AiProxy::cancel_owner`]), so a request whose page went
    /// while its settings were read is refused at `open`. One counter per label ever used.
    pages: HashMap<String, u64>,
}

struct Entry {
    /// The label of the webview that sent the request.
    owner: String,
    token: CancellationToken,
    vault_closed: Arc<AtomicBool>,
}

impl AiProxy {
    /// A proxy on `builder` (the shared TLS stack) with redirects off: reqwest keeps
    /// `x-api-key` and `x-goog-api-key` across a cross-host redirect, so a 3xx goes back to the
    /// renderer as the provider's answer and is never followed. It never goes through a proxy,
    /// as Electron's Node `fetch` did not.
    pub fn new(builder: reqwest::ClientBuilder) -> Arc<Self> {
        Arc::new(Self {
            client: builder
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("the AI proxy HTTP client needs a process default rustls crypto provider"),
            in_flight: Mutex::new(InFlight::default()),
        })
    }

    /// Ends every request when the vault closes: the next vault has other settings and keys.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let proxy = Arc::clone(self);
        session.on_close("ai-proxy", Arc::new(move |_| proxy.cancel_all()));
    }

    /// Ends request `id`, before or after its head. An unknown id has ended or has not opened
    /// yet; it is remembered so that an `open` arriving after it is refused.
    pub fn cancel(&self, id: &str) {
        let mut in_flight = self.lock();
        if let Some(entry) = in_flight.running.remove(id) {
            entry.token.cancel();
            return;
        }
        if in_flight.early.len() == EARLY_CANCELS {
            in_flight.early.pop_front();
        }
        in_flight.early.push_back(id.to_owned());
    }

    /// Forgets that `id` was cancelled before it opened: its request was refused before
    /// `open` (its settings could not be read), so no `open` will ever take the id.
    pub fn forget_cancel(&self, id: &str) {
        let mut in_flight = self.lock();
        if let Some(at) = in_flight.early.iter().position(|early| early == id) {
            in_flight.early.remove(at);
        }
    }

    /// The page of the webview labelled `label` as it is now. Take it before anything that can
    /// wait, so that a reload during the wait refuses the request at `open`.
    pub fn owner(&self, label: &str) -> Owner {
        Owner {
            label: label.to_owned(),
            generation: self.lock().pages.get(label).copied().unwrap_or(0),
        }
    }

    /// Ends every request of the webview labelled `owner`: its page reloaded or its window
    /// closed. A request of that page that has not opened yet is refused when it does.
    pub fn cancel_owner(&self, owner: &str) {
        let mut in_flight = self.lock();
        *in_flight.pages.entry(owner.to_owned()).or_default() += 1;
        in_flight.running.retain(|_, entry| {
            let keep = entry.owner != owner;
            if !keep {
                entry.token.cancel();
            }
            keep
        });
    }

    /// Ends every request; each streaming body ends with `Failed("the vault closed")`, and a
    /// request still waiting for its head with [`ProxyError::VaultClosed`].
    pub fn cancel_all(&self) {
        let mut in_flight = self.lock();
        in_flight.early.clear();
        for (_, entry) in in_flight.running.drain() {
            entry.vault_closed.store(true, Ordering::SeqCst);
            entry.token.cancel();
        }
    }

    /// The number of requests not yet ended.
    pub fn in_flight(&self) -> usize {
        self.lock().running.len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InFlight> {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Sends `request` of `owner` with the key of `settings` (read in Rust, never the
    /// renderer's) and returns the head once it arrives, with the future that streams the body
    /// into `sink`. The caller spawns that future; dropping it ends the upstream request.
    pub async fn open(
        self: &Arc<Self>,
        settings: &InlineAiSettings,
        request: AiProviderRequest,
        owner: &Owner,
        mut sink: Sink,
    ) -> Result<(AiProviderHead, impl Future<Output = ()> + Send + 'static), ProxyError> {
        let Prepared { url, headers, name } = match prepare(settings, &request) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.forget_cancel(&request.request_id);
                return Err(error);
            }
        };
        let token = CancellationToken::new();
        let vault_closed = Arc::new(AtomicBool::new(false));
        let id = request.request_id;
        {
            let mut in_flight = self.lock();
            if let Some(at) = in_flight.early.iter().position(|early| *early == id) {
                in_flight.early.remove(at);
                return Err(ProxyError::Cancelled);
            }
            if in_flight.pages.get(&owner.label).copied().unwrap_or(0) != owner.generation {
                return Err(ProxyError::Cancelled);
            }
            if in_flight.running.contains_key(&id) {
                return Err(ProxyError::Invalid(format!(
                    "request {id} is already running"
                )));
            }
            in_flight.running.insert(
                id.clone(),
                Entry {
                    owner: owner.label.clone(),
                    token: token.clone(),
                    vault_closed: Arc::clone(&vault_closed),
                },
            );
        }
        let ticket = Ticket {
            proxy: Arc::clone(self),
            id,
            token: token.clone(),
            vault_closed,
        };

        let method = match request.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Post => reqwest::Method::POST,
        };
        let mut builder = self.client.request(method, url).headers(headers);
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let mut response = tokio::select! {
            () = token.cancelled() => {
                return Err(if ticket.vault_closed.load(Ordering::SeqCst) {
                    ProxyError::VaultClosed
                } else {
                    ProxyError::Cancelled
                });
            }
            sent = builder.send() => sent.map_err(|error| {
                tracing::info!(scope = "AIProxy", "{name} request failed: {}", error.without_url());
                ProxyError::Unreachable { provider: name.clone() }
            })?,
        };
        let head = AiProviderHead {
            status: response.status().as_u16(),
            headers: response_headers(response.headers()),
        };
        if response.status() == StatusCode::UNAUTHORIZED {
            tracing::info!(scope = "AIProxy", "{name} rejected the stored API key");
        }
        let body = async move {
            let ticket = ticket;
            loop {
                let chunk = tokio::select! {
                    () = ticket.token.cancelled() => {
                        if ticket.vault_closed.load(Ordering::SeqCst) {
                            sink(Frame::Failed(VAULT_CLOSED.to_owned()));
                        }
                        return;
                    }
                    chunk = response.chunk() => chunk,
                };
                let frame = match chunk {
                    Ok(Some(bytes)) => Frame::Data(bytes.to_vec()),
                    Ok(None) => {
                        sink(Frame::End);
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(
                            scope = "AIProxy",
                            "{name} stream broke off: {}",
                            error.without_url()
                        );
                        sink(Frame::Failed(format!("{name}: the connection broke off")));
                        return;
                    }
                };
                if !sink(frame) {
                    return;
                }
            }
        };
        Ok((head, body))
    }

    /// [`AiProxy::open`] for a caller in Rust that wants the whole answer: the body is read to
    /// its end, at most `cap` bytes. A body that breaks off or ends without its end (a cancel)
    /// is an error.
    pub async fn call(
        self: &Arc<Self>,
        settings: &InlineAiSettings,
        request: AiProviderRequest,
        owner: &Owner,
        cap: usize,
    ) -> Result<Answer, ProxyError> {
        #[derive(Default)]
        struct Read {
            body: Vec<u8>,
            ended: bool,
            over: bool,
            failed: Option<String>,
        }
        let read = Arc::new(Mutex::new(Read::default()));
        let into = Arc::clone(&read);
        let sink: Sink = Box::new(move |frame| {
            let mut read = into.lock().unwrap_or_else(PoisonError::into_inner);
            match frame {
                Frame::Data(bytes) if read.body.len() + bytes.len() > cap => {
                    read.over = true;
                    return false;
                }
                Frame::Data(bytes) => read.body.extend_from_slice(&bytes),
                Frame::End => read.ended = true,
                Frame::Failed(message) => read.failed = Some(message),
            }
            true
        });
        let provider = settings.provider.name(&settings.base_url);
        let (head, body) = self.open(settings, request, owner, sink).await?;
        body.await;
        let read = std::mem::take(&mut *read.lock().unwrap_or_else(PoisonError::into_inner));
        if read.over {
            return Err(ProxyError::AnswerTooLarge { provider, cap });
        }
        match read.failed {
            Some(message) if message == VAULT_CLOSED => return Err(ProxyError::VaultClosed),
            Some(message) => return Err(ProxyError::BrokeOff(message)),
            None => {}
        }
        if !read.ended {
            return Err(ProxyError::Cancelled);
        }
        Ok(Answer {
            status: head.status,
            headers: head.headers,
            body: read.body,
        })
    }
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

/// A request's entry in the in-flight map, removed when the request ends however it ends.
struct Ticket {
    proxy: Arc<AiProxy>,
    id: String,
    token: CancellationToken,
    vault_closed: Arc<AtomicBool>,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        // A cancelled request was removed by the cancel, and its id may be in use again. One
        // that was not still owns its entry: a running id is never taken twice.
        if !self.token.is_cancelled() {
            self.proxy.lock().running.remove(&self.id);
        }
    }
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
fn response_headers(headers: &HeaderMap) -> Vec<HeaderPair> {
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
