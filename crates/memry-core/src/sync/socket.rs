//! The realtime hint client, chapter 09, over the `Transport` seam's
//! `open_socket`.
//!
//! **The socket is never a data path.** Every frame it delivers is a hint that
//! the client should run its ordinary pull (chapters 05 and 07); nothing is
//! ever applied from one. That is why [`Hint`] carries ids and nothing else,
//! and why [`HintSink`] is the whole of this module's output. A
//! `changes_available` frame's `cursor` is carried only as a skip filter for
//! [`crate::sync::engine::SyncEngine::wake`] (#2290): §9.11 says in as many
//! words that **a client MUST NOT use the broadcast's cursor as its own**.
//!
//! Five more rules, each of which is a way to get this wrong:
//!
//! - **`type` is a plain string, not an enum** (§9.4). A newer server can add
//!   one, and a client MUST NOT reject a frame for carrying a name it does not
//!   know. [`parse_frame`] answers `None` **only** when the bytes are not a
//!   message envelope at all — bad JSON, or no `type` (§9.12) — and everything
//!   else collapses to [`Hint::Ignored`].
//! - **The keepalive must be exactly `ping`** (§9.6). Cloudflare answers that
//!   one payload without waking the Durable Object or spending the socket's
//!   inbound budget; any other text is a real message that costs a wake on
//!   every beat.
//! - **One socket per device** (§9.3). A second connection silently closes the
//!   first with 4001, so this client holds at most one handle.
//! - **4004 and 4009 are terminal** (§9.9). Reconnection latches off: for 4004
//!   by signing the device out, for 4009 until the application is updated.
//! - **A 4003 is not reconnected into** (§9.10.1). The same expired token
//!   earns another 4003 and burns an attempt; the refresh comes first, and the
//!   attempt counter resets afterwards because the disconnection was expected.
//!
//! The socket is a **foreground facility** (§9.1). A conforming client SHOULD
//! open it in the foreground and MUST close it when backgrounded, and on
//! returning to the foreground MUST run a full pull rather than assuming the
//! socket told it everything — broadcasts sent while it was away are gone.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::api::errors::TransportError;
use crate::protocol::http::{AUTHORIZATION_HEADER, ClientIdentity, TokenProvider, VAULT_ID_HEADER};
use crate::seams::transport::{SocketHandle, SocketListener, SocketRequest, Transport};

pub use super::socket_frame::{Hint, parse_frame};

/// §9.2. Authentication is handshake headers only — never a query parameter
/// and never a subprotocol.
pub const SOCKET_PATH: &str = "/sync/ws";
/// §9.2: absent is `426 SYNC_VERSION_INCOMPATIBLE`, so this header is not
/// optional the way the HTTP client's identity header set can look.
pub const APP_VERSION_HEADER: &str = "x-app-version";

/// §9.6, `PING_INTERVAL_MS`.
pub const PING_INTERVAL_MS: u64 = 25_000;
/// §9.6: the literal text frame, and no other.
pub const KEEPALIVE_FRAME: &[u8] = b"ping";

/// §9.10's ladder.
pub const BASE_RECONNECT_DELAY_MS: u64 = 1_000;
pub const MAX_RECONNECT_DELAY_MS: u64 = 30_000;
pub const RECONNECT_JITTER_MS: u64 = 500;

/// §9.9's close codes.
pub const CLOSE_REPLACED: u16 = 4001;
pub const CLOSE_TOKEN_EXPIRED: u16 = 4003;
pub const CLOSE_DEVICE_REVOKED: u16 = 4004;
pub const CLOSE_RATE_LIMITED: u16 = 4008;
pub const CLOSE_VERSION_INCOMPATIBLE: u16 = 4009;

/// Where hints go. **Synchronous on purpose**: `SocketListener::on_message`
/// runs on whatever thread the shell's socket delivered on, with no async
/// runtime in scope, so a sink that awaited would either block that thread or
/// need a runtime handle the core has no business capturing. A sink that
/// forwards to a channel and lets the engine's own task run the pass is the
/// shape this supports.
pub trait HintSink: Send + Sync {
    fn hint(&self, hint: Hint);
}

/// Whether a close is reconnected into, and after how long.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reconnect {
    /// Reconnect after this delay.
    After { delay_ms: u64 },
    /// §9.10.1: refresh the access token first. The backoff counter is
    /// **reset**, because the disconnection was expected rather than a fault.
    AfterRefresh,
    /// §9.9: 4004 and 4009. The latch stays set for the session.
    Terminal(Terminal),
    /// The client no longer wants a connection.
    Stopped,
}

/// The two terminal close conditions of §9.9, kept apart because they mean
/// different things to a user: one signs the device out, the other waits for
/// an application update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    DeviceRevoked,
    VersionIncompatible,
}

/// §9.10: `min(BASE * 2^attempt + random()*JITTER, MAX)`.
///
/// `jitter_ms` is passed in rather than drawn here, so the ladder is a
/// function a test can pin. Chapter 00 §0.6.1's HTTP ladder has no jitter and
/// is a different mechanism; this one keeps the chapter's.
pub fn reconnect_delay_ms(attempt: u32, jitter_ms: u64) -> u64 {
    let doubled = BASE_RECONNECT_DELAY_MS.saturating_mul(1u64 << attempt.min(16));
    doubled
        .saturating_add(jitter_ms.min(RECONNECT_JITTER_MS))
        .min(MAX_RECONNECT_DELAY_MS)
}

/// The realtime hint client. One per device (§9.3).
pub struct RealtimeClient {
    transport: Arc<dyn Transport>,
    url: String,
    identity: ClientIdentity,
    vault_id: Option<String>,
    tokens: Arc<dyn TokenProvider>,
    sink: Arc<dyn HintSink>,
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    handle: Option<Arc<dyn SocketHandle>>,
    /// Reset to zero on a successful open (§9.10).
    attempt: u32,
    /// §9.10's latches.
    wants_connection: bool,
    terminal: Option<Terminal>,
    /// The last close this client saw, for `note_closed`.
    last_close: Option<u16>,
    open: bool,
}

impl RealtimeClient {
    /// `base_url` is the HTTP base the [`crate::protocol::http::HttpClient`]
    /// uses; the scheme is mapped to `ws`/`wss` here because the seam takes a
    /// URL and the shell must not be the one deciding what a socket URL looks
    /// like.
    pub fn new(
        transport: Arc<dyn Transport>,
        base_url: &str,
        identity: ClientIdentity,
        tokens: Arc<dyn TokenProvider>,
        sink: Arc<dyn HintSink>,
    ) -> Self {
        Self {
            transport,
            url: socket_url(base_url),
            identity,
            vault_id: None,
            tokens,
            sink,
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    /// §9.2: a socket on the wrong vault connects and then hears nothing,
    /// because every broadcast is filtered by the socket's attached vault.
    pub fn with_vault(mut self, vault_id: &str) -> Self {
        self.vault_id = Some(vault_id.to_owned());
        self
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn is_open(&self) -> bool {
        self.lock().open
    }

    pub fn terminal(&self) -> Option<Terminal> {
        self.lock().terminal
    }

    /// Opens the one socket. §9.3: an existing one is closed first, because a
    /// second connection for the same device silently kills the first anyway
    /// and doing it here keeps the kill visible.
    pub async fn connect(&self) -> Result<(), TransportError> {
        if let Some(terminal) = self.terminal() {
            return Err(TransportError::SocketClosed {
                code: match terminal {
                    Terminal::DeviceRevoked => CLOSE_DEVICE_REVOKED,
                    Terminal::VersionIncompatible => CLOSE_VERSION_INCOMPATIBLE,
                },
                reason: "reconnection is latched off for this session".to_owned(),
            });
        }
        self.close_handle();
        {
            let mut inner = self.lock();
            inner.wants_connection = true;
            inner.last_close = None;
        }

        let listener: Arc<dyn SocketListener> = Arc::new(Bridge {
            inner: Arc::clone(&self.inner),
            sink: Arc::clone(&self.sink),
        });
        let handle = self
            .transport
            .open_socket(self.handshake().await, listener)?;
        self.lock().handle = Some(handle);
        Ok(())
    }

    /// §9.1: the socket MUST be closed when the application is backgrounded,
    /// and the caller MUST run a full pull on returning.
    pub fn disconnect(&self) {
        self.lock().wants_connection = false;
        self.close_handle();
    }

    /// §9.6's beat. Exactly `ping`, so Cloudflare's request-response pair
    /// answers it without waking the Durable Object or spending the socket's
    /// inbound rate-limit budget (§9.7).
    pub fn ping(&self) -> Result<(), TransportError> {
        let handle = self
            .lock()
            .handle
            .clone()
            .ok_or(TransportError::SocketClosed {
                code: 0,
                reason: "no socket is open".to_owned(),
            })?;
        handle.send(KEEPALIVE_FRAME.to_vec())
    }

    /// §9.8: re-authenticate in place rather than tearing the socket down.
    /// Rejection is non-fatal — the socket keeps its existing `tokenExp` and
    /// the alarm closes it at the original expiry.
    pub async fn reauthenticate(&self) -> Result<(), TransportError> {
        let Some(token) = self.tokens.access_token().await else {
            return Ok(());
        };
        let handle = self
            .lock()
            .handle
            .clone()
            .ok_or(TransportError::SocketClosed {
                code: 0,
                reason: "no socket is open".to_owned(),
            })?;
        let frame = json!({ "type": "auth", "payload": { "token": token } });
        handle.send(serde_json::to_vec(&frame).expect("the auth frame is serialisable"))
    }

    /// §9.9 and §9.10, applied to the last close this client saw.
    ///
    /// Called by whatever drives reconnection; it both decides and records, so
    /// the attempt counter advances once per scheduled reconnect rather than
    /// once per question asked.
    pub fn note_closed(&self) -> Reconnect {
        let mut inner = self.lock();
        inner.open = false;
        inner.handle = None;
        let code = inner.last_close.take();

        if let Some(terminal) = match code {
            Some(CLOSE_DEVICE_REVOKED) => Some(Terminal::DeviceRevoked),
            Some(CLOSE_VERSION_INCOMPATIBLE) => Some(Terminal::VersionIncompatible),
            _ => None,
        } {
            inner.terminal = Some(terminal);
            inner.wants_connection = false;
            return Reconnect::Terminal(terminal);
        }
        if let Some(terminal) = inner.terminal {
            return Reconnect::Terminal(terminal);
        }
        if !inner.wants_connection {
            return Reconnect::Stopped;
        }
        if code == Some(CLOSE_TOKEN_EXPIRED) {
            // §9.10.1: the same expired token yields another 4003 and burns an
            // attempt, so the refresh comes first and the counter resets.
            inner.attempt = 0;
            return Reconnect::AfterRefresh;
        }

        let attempt = inner.attempt;
        inner.attempt = attempt.saturating_add(1);
        Reconnect::After {
            delay_ms: reconnect_delay_ms(attempt, jitter_ms()),
        }
    }

    async fn handshake(&self) -> SocketRequest {
        let mut headers = HashMap::new();
        if let Some(token) = self.tokens.access_token().await {
            headers.insert(AUTHORIZATION_HEADER.to_owned(), format!("Bearer {token}"));
        }
        // §9.2: absent is `426 SYNC_VERSION_INCOMPATIBLE`. Not optional.
        headers.insert(
            APP_VERSION_HEADER.to_owned(),
            self.identity.app_version().to_owned(),
        );
        if let Some(vault_id) = &self.vault_id {
            headers.insert(VAULT_ID_HEADER.to_owned(), vault_id.clone());
        }
        SocketRequest {
            url: self.url.clone(),
            headers,
        }
    }

    fn close_handle(&self) {
        let handle = self.lock().handle.take();
        if let Some(handle) = handle {
            handle.close();
        }
        self.lock().open = false;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What the shell calls into. Deliberately thin: it records the socket's
/// lifecycle and forwards parsed hints, and makes no protocol decision of its
/// own (Constitution I).
struct Bridge {
    inner: Arc<Mutex<Inner>>,
    sink: Arc<dyn HintSink>,
}

impl Bridge {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SocketListener for Bridge {
    fn on_open(&self) {
        let mut inner = self.lock();
        inner.open = true;
        // §9.10: reset to zero on a successful open.
        inner.attempt = 0;
    }

    fn on_message(&self, payload: Vec<u8>) {
        // §9.12: `None` is the only case worth logging, and it is still not a
        // reason to reject the socket.
        if let Some(hint) = parse_frame(&payload) {
            self.sink.hint(hint);
        }
    }

    fn on_closed(&self, code: u16, _reason: String) {
        let mut inner = self.lock();
        inner.open = false;
        inner.last_close = Some(code);
    }

    fn on_error(&self, _error: TransportError) {
        let mut inner = self.lock();
        inner.open = false;
        // No code: an error is not one of §9.9's closes, so it takes the
        // ordinary backoff branch rather than a latch.
        inner.last_close = None;
    }
}

/// `http` → `ws`, `https` → `wss`, plus §9.2's path.
fn socket_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let mapped = match base.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        _ => base.to_owned(),
    };
    format!("{mapped}{SOCKET_PATH}")
}

/// §9.10's `random() * JITTER`.
fn jitter_ms() -> u64 {
    // Not a cryptographic draw and not trying to be: this exists so a fleet
    // does not reconnect in lockstep, and the client population is one device
    // per account anyway (chapter 00 §0.6.1).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos() as u64)
        .unwrap_or_default();
    nanos % RECONNECT_JITTER_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_doubles_and_clamps_at_thirty_seconds() {
        assert_eq!(reconnect_delay_ms(0, 0), 1_000);
        assert_eq!(reconnect_delay_ms(1, 0), 2_000);
        assert_eq!(reconnect_delay_ms(4, 0), 16_000);
        assert_eq!(reconnect_delay_ms(5, 0), 30_000);
        assert_eq!(reconnect_delay_ms(30, 500), MAX_RECONNECT_DELAY_MS);
        // The jitter is added before the clamp and never exceeds its own cap.
        assert_eq!(reconnect_delay_ms(0, 500), 1_500);
        assert_eq!(reconnect_delay_ms(0, 9_999), 1_500);
    }

    #[test]
    fn the_socket_url_maps_the_scheme_and_appends_the_path() {
        assert_eq!(
            socket_url("https://example.test"),
            "wss://example.test/sync/ws"
        );
        assert_eq!(
            socket_url("http://localhost:8787/"),
            "ws://localhost:8787/sync/ws"
        );
    }
}
