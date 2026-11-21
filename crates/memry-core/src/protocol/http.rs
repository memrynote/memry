//! The HTTP client, over the `Transport` seam (chapters 00, 05 §5.2, 11).
//!
//! **Every policy lives here and none of it lives in the shell** (Constitution
//! I). The seam takes one request and gives back one response; the retry
//! ladder, the backoff, the token refresh, the error-body parse and the header
//! set are this module's, so that iOS, the CLI and any later shell cannot
//! disagree about them.
//!
//! **A non-2xx is a response, not a failure.** Chapter 00 §0.4: the body
//! carries the code, and three of the codes mean something a caller must act
//! on rather than retry — `PLATFORM_WRITES_DISABLED` parks the outbox,
//! `CLIENT_UPGRADE_REQUIRED` offers an update, and a 501 from the bootstrap
//! routes says this deployment never had the feature (chapter 10 §10.12).
//!
//! **Header casing.** The seam normalises header keys to lowercase, so every
//! constant here is lowercase. Chapter 05 §5.2 spells `X-Memry-Sync-Types` and
//! `X-Memry-Vault-Id` in TitleCase and `x-memry-client` in lowercase; HTTP
//! names are case-insensitive, so the asymmetry is cosmetic and normalising at
//! one place keeps every reader in the core from guessing the shell's spelling.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::api::errors::{ApiError, TransportError};
use crate::seams::transport::{HttpRequest, HttpResponse, Transport};

mod error_body;
mod identity;
mod retry;

pub use error_body::{ErrorBody, parse_error_body};
pub use identity::{CLIENT_PLATFORMS, ClientIdentity};
pub use retry::{
    DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_RETRIES, MAX_RETRY_DELAY_MS, MAX_WALK_RETRY_DELAY_MS,
    RetryPolicy,
};

/// Chapter 00 §0.6. A ceiling is mandatory, not advisory: a socket frozen by
/// the OS backgrounding the app otherwise never resolves.
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Chapter 00 §0.6. A request that receives no bytes for this long fails as a
/// timeout, whatever its deadline: the shell applies it to every request.
pub const IDLE_TIMEOUT_MS: u64 = 60_000;

pub const CLIENT_HEADER: &str = "x-memry-client";
pub const SYNC_TYPES_HEADER: &str = "x-memry-sync-types";
pub const VAULT_ID_HEADER: &str = "x-memry-vault-id";
pub const BOOTSTRAP_TOKEN_HEADER: &str = "x-memry-bootstrap-token";
pub const AUTHORIZATION_HEADER: &str = "authorization";
pub const RETRY_AFTER_HEADER: &str = "retry-after";

/// How a request authenticates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    /// No `Authorization` header. `/auth/otp/*`, `/auth/refresh`,
    /// `/auth/recovery`, `GET /health`.
    None,
    /// A token the caller holds: a setup token on `POST /auth/devices`, a
    /// bootstrap token, a one-off.
    Bearer(String),
    /// The session's access token, taken from the `TokenProvider`, refreshed
    /// once on a 401 and replayed.
    Session,
}

/// What the client asks the seam to do, before headers and retries are added.
#[derive(Debug, Clone)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Vec<u8>>,
    pub headers: HashMap<String, String>,
    pub auth: Auth,
    pub retry: RetryPolicy,
    pub timeout_ms: u64,
}

impl ApiRequest {
    pub fn new(method: &str, path: &str) -> Self {
        Self {
            method: method.to_string(),
            path: path.to_string(),
            body: None,
            headers: HashMap::new(),
            auth: Auth::None,
            retry: RetryPolicy::default(),
            timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
        }
    }

    pub fn get(path: &str) -> Self {
        Self::new("GET", path)
    }

    pub fn post(path: &str) -> Self {
        Self::new("POST", path)
    }

    pub fn json<T: Serialize>(mut self, body: &T) -> Self {
        // A body this client builds itself cannot fail to serialise; a panic
        // here would mean a struct in this crate is not `Serialize`-able,
        // which is a compile-time fact that happens to be checked at runtime.
        self.body = Some(serde_json::to_vec(body).expect("request body is serialisable"));
        self
    }

    /// Raw bytes as the body, for a request that is not JSON.
    ///
    /// An attachment chunk is `nonce ‖ ciphertext` and goes up as-is:
    /// base64-ing it through [`Self::json`] would inflate every upload by a
    /// third for no reader's benefit.
    pub fn body(mut self, bytes: Vec<u8>) -> Self {
        self.body = Some(bytes);
        self
    }

    pub fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }

    pub fn retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .insert(name.to_ascii_lowercase(), value.to_string());
        self
    }
}

/// Where the core's sleeps go, so a test can assert the ladder's delays
/// without living through them.
#[async_trait::async_trait]
pub trait Sleeper: Send + Sync {
    async fn sleep_ms(&self, ms: u64);
}

pub struct TokioSleeper;

#[async_trait::async_trait]
impl Sleeper for TokioSleeper {
    async fn sleep_ms(&self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

/// The session's tokens, as the HTTP client needs to see them.
///
/// A trait rather than a direct dependency on the token manager, because the
/// manager refreshes over this same client: the manager holds a client whose
/// provider is `None`, and nothing owns a cycle.
#[async_trait::async_trait]
pub trait TokenProvider: Send + Sync {
    /// The access token to send, or `None` when there is no session.
    async fn access_token(&self) -> Option<String>;

    /// Single-flighted refresh (chapter 02 §2.10). `stale` is the token the
    /// caller sent, so a provider that has already refreshed can return the
    /// current one without a second round trip.
    async fn refresh(&self, stale: &str) -> Result<String, ApiError>;
}

/// The client. One per server, shared by every caller.
pub struct HttpClient {
    transport: Arc<dyn Transport>,
    base_url: String,
    identity: ClientIdentity,
    tokens: Option<Arc<dyn TokenProvider>>,
    sleeper: Arc<dyn Sleeper>,
}

impl HttpClient {
    pub fn new(transport: Arc<dyn Transport>, base_url: &str, identity: ClientIdentity) -> Self {
        Self {
            transport,
            base_url: base_url.trim_end_matches('/').to_string(),
            identity,
            tokens: None,
            sleeper: Arc::new(TokioSleeper),
        }
    }

    pub fn with_tokens(mut self, tokens: Arc<dyn TokenProvider>) -> Self {
        self.tokens = Some(tokens);
        self
    }

    pub fn with_sleeper(mut self, sleeper: Arc<dyn Sleeper>) -> Self {
        self.sleeper = sleeper;
        self
    }

    pub async fn sleep_ms(&self, ms: u64) {
        self.sleeper.sleep_ms(ms).await;
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn identity(&self) -> &ClientIdentity {
        &self.identity
    }

    /// The seam this client sends over, for the realtime socket that shares it.
    pub fn transport(&self) -> Arc<dyn Transport> {
        Arc::clone(&self.transport)
    }

    /// Sends a request, running the ladder. Returns the 2xx response or the
    /// classified failure.
    pub async fn send(&self, request: ApiRequest) -> Result<HttpResponse, ApiError> {
        let mut attempt: u32 = 0;
        let mut refreshed = false;
        loop {
            let (wire, sent_token) = self.build(&request).await;
            let outcome = match self.transport.send(wire).await {
                Ok(response) => self.classify(&request, response),
                Err(error) => Outcome::Transport(error),
            };

            match outcome {
                Outcome::Done(response) => return Ok(response),
                Outcome::Fatal(error) => return Err(error),

                // A 401 on an ordinary call is demand-driven refresh, not a
                // retry: chapter 02 §2.10's storm came from callers that
                // re-entered refresh, so this happens **once** per request and
                // does not touch the retry budget. A refused refresh returns
                // the call's own 401. Any other refresh failure is returned as
                // itself (#4156): the session is still good, and the stale 401
                // would tell the user they were signed out (chapter 02 §2.10).
                Outcome::RefreshAndReplay(error) => {
                    let (Some(tokens), Some(stale), false) =
                        (self.tokens.as_ref(), sent_token, refreshed)
                    else {
                        return Err(error);
                    };
                    refreshed = true;
                    match tokens.refresh(&stale).await {
                        Ok(_) => {}
                        Err(ApiError::Unauthorized { .. }) => return Err(error),
                        Err(refresh_error) => return Err(refresh_error),
                    }
                }

                Outcome::Retry { error, delay_ms } => {
                    if attempt >= request.retry.max_retries {
                        return Err(error);
                    }
                    let delay = delay_ms.unwrap_or_else(|| request.retry.backoff_ms(attempt));
                    // **The server's wait is honoured, not obeyed without
                    // limit.** A rate limiter counting down a long window
                    // answers `Retry-After: 2358`, and a client that sleeps
                    // through it is a screen stuck on "Sending your code" for
                    // thirty-nine minutes with no error and no way out. Past
                    // the ceiling the wait is the caller's to make, so the
                    // rate-limit error — which carries `retry_after_s` — is
                    // returned and the user is told how long it is.
                    if delay > request.retry.max_delay_ms {
                        return Err(error);
                    }
                    attempt += 1;
                    self.sleeper.sleep_ms(delay).await;
                }

                Outcome::Transport(error) => {
                    let spent_deadline = matches!(error, TransportError::Timeout { elapsed_ms }
                        if elapsed_ms >= request.timeout_ms && !request.retry.retry_after_deadline);
                    if !retryable_transport(&error)
                        || spent_deadline
                        || attempt >= request.retry.max_retries
                    {
                        return Err(ApiError::Transport { source: error });
                    }
                    let delay = request.retry.backoff_ms(attempt);
                    attempt += 1;
                    self.sleeper.sleep_ms(delay).await;
                }
            }
        }
    }

    /// `send`, with the 2xx body parsed. A 2xx that does not parse is
    /// `MalformedResponse` rather than a silent default.
    pub async fn send_json<T: DeserializeOwned>(&self, request: ApiRequest) -> Result<T, ApiError> {
        let path = request.path.clone();
        let response = self.send(request).await?;
        serde_json::from_slice(&response.body).map_err(|e| ApiError::MalformedResponse {
            path,
            what: e.to_string(),
        })
    }

    /// Builds the wire request, returning the access token it attached so a
    /// refresh knows which one went stale.
    async fn build(&self, request: &ApiRequest) -> (HttpRequest, Option<String>) {
        let mut headers = HashMap::new();
        // Chapter 00 §0.6: JSON both ways on every request.
        headers.insert("content-type".to_string(), "application/json".to_string());
        headers.insert("accept".to_string(), "application/json".to_string());
        // FR-034, chapter 11 §11.1: on **every** request, including the
        // unauthenticated ones, because the server parses identity on reads too.
        headers.insert(CLIENT_HEADER.to_string(), self.identity.header_value());
        for (name, value) in &request.headers {
            headers.insert(name.clone(), value.clone());
        }

        let mut sent_token = None;
        match &request.auth {
            Auth::None => {}
            Auth::Bearer(token) => {
                headers.insert(AUTHORIZATION_HEADER.to_string(), format!("Bearer {token}"));
            }
            Auth::Session => {
                if let Some(tokens) = self.tokens.as_ref()
                    && let Some(token) = tokens.access_token().await
                {
                    headers.insert(AUTHORIZATION_HEADER.to_string(), format!("Bearer {token}"));
                    sent_token = Some(token);
                }
            }
        }

        let wire = HttpRequest {
            method: request.method.clone(),
            // A presigned R2 url (§14.6) is already absolute; prefixing it with
            // the Worker's base would send it nowhere.
            url: if request.path.starts_with("https://") || request.path.starts_with("http://") {
                request.path.clone()
            } else {
                format!("{}{}", self.base_url, request.path)
            },
            headers,
            body: request.body.clone(),
            timeout_ms: request.timeout_ms,
        };
        (wire, sent_token)
    }

    fn classify(&self, request: &ApiRequest, response: HttpResponse) -> Outcome {
        let status = response.status;
        if (200..300).contains(&status) {
            return Outcome::Done(response);
        }
        let body = parse_error_body(status, &response.body);
        let code = body.code.as_deref().unwrap_or_default().to_string();
        let message = body.message.clone();

        // Chapter 10 §10.12: a 501 is a deployment configuration fact. It is
        // taken out of the 5xx branch above everything else, because a
        // retryable-5xx caller would otherwise spend its whole ladder on a
        // condition that cannot change within a deployment.
        if status == 501 && code == "BOOTSTRAP_UNAVAILABLE" {
            return Outcome::Fatal(ApiError::BootstrapUnavailable);
        }

        // Chapter 14 §14.6: `STORAGE_PRESIGN_UNAVAILABLE` is typed and
        // **permanent for that deployment**, and a client MUST NOT retry the
        // presign route on a timer. It arrives as a 503, so without this it
        // falls into the retryable-5xx branch below and every presign call
        // spends a full ladder on a condition that cannot change — the same
        // reasoning the 501 above is lifted out for.
        //
        // Kept as a `Status` carrying the code rather than given its own
        // variant, because the caller's correct response is not to fail: it
        // switches to the proxied path and records that this deployment does
        // not presign.
        if code == "STORAGE_PRESIGN_UNAVAILABLE" {
            return Outcome::Fatal(ApiError::Status {
                status,
                code: body.code,
                message,
            });
        }

        match (status, code.as_str()) {
            (_, "AUTH_DEVICE_REVOKED") => Outcome::Fatal(ApiError::DeviceRevoked { message }),
            (409, "AUTH_DEVICE_LIMIT_REACHED") => {
                Outcome::Fatal(ApiError::DeviceLimitReached { message })
            }
            // #5373: the plan's vault cap, from any route that checks it
            // (`POST /sync/vaults` and every vault-scoped `/sync/*`). The
            // shell offers a larger plan; retrying changes nothing.
            (402, "SYNC_VAULT_LIMIT_EXCEEDED") => Outcome::Fatal(ApiError::PaymentRequired {
                code: body.code,
                message,
            }),
            (403, "PLATFORM_WRITES_DISABLED") => {
                Outcome::Fatal(ApiError::WritesDisabled { message })
            }
            (426, "CLIENT_UPGRADE_REQUIRED") => Outcome::Fatal(ApiError::UpgradeRequired {
                min_version: body.min_version,
                message,
            }),
            (401, _) => {
                let error = ApiError::Unauthorized { code, message };
                if matches!(request.auth, Auth::Session) {
                    Outcome::RefreshAndReplay(error)
                } else {
                    Outcome::Fatal(error)
                }
            }
            (429, _) => {
                let retry_after_s = response
                    .headers
                    .get(RETRY_AFTER_HEADER)
                    .and_then(|v| v.trim().parse::<u64>().ok());
                let error = ApiError::RateLimited {
                    retry_after_s,
                    message,
                };
                if request.retry.retry_on_429 {
                    Outcome::Retry {
                        error,
                        delay_ms: retry_after_s.map(|s| s.saturating_mul(1_000)),
                    }
                } else {
                    Outcome::Fatal(error)
                }
            }
            // Chapter 00 §0.5: `INTERNAL_ERROR` is 500, 502 or 503 and is the
            // only status set the table calls retryable. 501 is a capability
            // statement, and 4xx is the client's own fault either way.
            (500 | 502 | 503, _) if request.retry.retry_on_5xx => Outcome::Retry {
                error: ApiError::Status {
                    status,
                    code: body.code,
                    message,
                },
                delay_ms: None,
            },
            _ => Outcome::Fatal(ApiError::Status {
                status,
                code: body.code,
                message,
            }),
        }
    }
}

/// What one attempt produced.
enum Outcome {
    Done(HttpResponse),
    Fatal(ApiError),
    Retry {
        error: ApiError,
        /// Set when the server told the client how long to wait.
        delay_ms: Option<u64>,
    },
    RefreshAndReplay(ApiError),
    Transport(TransportError),
}

/// Chapter 00 §0.6 and the `TransportError` doc comments: a TLS failure is not
/// retried, because retrying a certificate failure turns a possible
/// interception into a loop, and a cancel is the user's decision and must not
/// count against a budget.
fn retryable_transport(error: &TransportError) -> bool {
    match error {
        TransportError::Offline
        | TransportError::Timeout { .. }
        | TransportError::Failed { .. } => true,
        TransportError::Tls { .. }
        | TransportError::Cancelled
        | TransportError::SocketClosed { .. }
        | TransportError::HandshakeRejected { .. } => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_and_cancellation_are_not_retried() {
        assert!(retryable_transport(&TransportError::Offline));
        assert!(retryable_transport(&TransportError::Timeout {
            elapsed_ms: 1
        }));
        assert!(!retryable_transport(&TransportError::Cancelled));
        assert!(!retryable_transport(&TransportError::Tls {
            what: "bad cert".into()
        }));
    }
}
