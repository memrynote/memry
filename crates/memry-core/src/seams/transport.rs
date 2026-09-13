//! The network seam, research R5 and FR-017.
//!
//! **One trait, not two.** HTTP and the realtime socket are the same seam to the
//! same host, and splitting them buys a second implementation of the same
//! lifetime rules for no gain.
//!
//! **It is deliberately dumb.** One request in, status plus headers plus bytes
//! out. Every retry, every backoff, every token refresh and every protocol
//! decision stays in Rust (Constitution I). A shell that adds a retry here
//! duplicates a policy the core already owns and the two disagree the first time
//! one of them changes.
//!
//! iOS implements it over `URLSession`, which is also why the core does not own
//! networking on device: iOS suspends raw sockets seconds after backgrounding,
//! and applies ATS, proxy configuration and background transfer only to its own
//! stack.

use std::collections::HashMap;
use std::sync::Arc;

use crate::api::errors::TransportError;

/// One outbound HTTP request.
///
/// `headers` keys are **lowercase**. Chapter 00 §0.6 reads `retry-after` from a
/// 429 in lowercase, so normalising at the seam is what keeps every reader in
/// the core from having to guess the shell's casing.
#[derive(Debug, Clone, uniffi::Record)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
    /// Chapter 00 §0.6: a per-request ceiling is mandatory, because a socket
    /// frozen by an OS backgrounding the app otherwise never resolves and
    /// latches the engine's in-flight guard permanently.
    pub timeout_ms: u64,
}

/// One inbound HTTP response. A non-2xx status is a **response**, not an error:
/// the core reads the body to find the error code (chapter 00 §0.4).
#[derive(Debug, Clone, uniffi::Record)]
pub struct HttpResponse {
    pub status: u16,
    /// Lowercase keys, as on the request.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// What the shell opens a realtime socket with.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SocketRequest {
    pub url: String,
    pub headers: HashMap<String, String>,
}

/// Events the shell pushes up from an open socket.
///
/// The socket is **never a data path** (chapter 09): a `Message` is a hint that
/// causes a pull, and nothing is applied from it. Modelling the payload as bytes
/// rather than as a parsed type is deliberate — it keeps the shell from growing
/// an opinion about the frame.
#[uniffi::export(with_foreign)]
pub trait SocketListener: Send + Sync {
    fn on_open(&self);
    fn on_message(&self, payload: Vec<u8>);
    fn on_closed(&self, code: u16, reason: String);
    fn on_error(&self, error: TransportError);
}

/// A socket the core can write to and close. Held by the core for the socket's
/// lifetime; dropping it closes the socket.
#[uniffi::export(with_foreign)]
pub trait SocketHandle: Send + Sync {
    fn send(&self, payload: Vec<u8>) -> Result<(), TransportError>;
    fn close(&self);
}

/// The one network seam.
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// A single request and response. No retry, no auth, no protocol logic.
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError>;

    /// Opens the realtime hint channel. Reconnect and backoff are the core's,
    /// not the shell's: a shell that reconnects on its own races the core's
    /// own policy and produces two sockets.
    ///
    /// **Synchronous on purpose.** Readiness arrives as `SocketListener::on_open`
    /// and failure as `on_error`, so awaiting the open would report the same
    /// facts twice through two different channels. It also sidesteps a UniFFI
    /// limitation: an async foreign method cannot return an `Arc<dyn Trait>`,
    /// because the desugared future is generic over a lifetime the generated
    /// `FfiConverterArc` impl is not.
    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError>;
}
