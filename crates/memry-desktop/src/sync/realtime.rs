//! The open vault's realtime socket (chapter 09), as the supervisor runs it: the core's
//! connect, keepalive and reconnect ladder (`socket_run`), plus the two latches desktop adds.
//!
//! - **Terminal closes.** A close 4004 or 4009, or a handshake refused 403 or 426, latches the
//!   socket off for the supervisor's life ([`TerminalLatch`]), as Electron's `versionRejected`
//!   and device-revoked handling do.
//! - **Pin failure.** A certificate pin mismatch on the socket ends it until the app restarts
//!   (`websocket.ts` `certPinFailed`); the transport refuses later sockets too.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_core::api::errors::TransportError;
use memry_core::protocol::http::TokenProvider;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::socket::{RealtimeClient, Terminal};
use memry_core::sync::socket_run::{self, RunEnd, StopSignal, TerminalLatch};

/// Why a socket run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketEnd {
    Stopped,
    Terminal(Terminal),
    /// §9.10: the handshake was refused 401. Tried again after the HTTP path next succeeds.
    Refused,
    PinFailed,
}

/// The socket as the supervisor runs it; tests put a fake behind it.
#[async_trait::async_trait]
pub trait RealtimeSocket: Send + Sync {
    /// Holds the socket until it is stopped or ends for good.
    async fn run(&self) -> SocketEnd;
    fn stop(&self);
}

/// The real socket over the core's client.
pub struct CoreSocket {
    client: RealtimeClient,
    tokens: Arc<dyn TokenProvider>,
    stop: Arc<StopSignal>,
    latch: Arc<TerminalLatch>,
    pin_failed: Arc<AtomicBool>,
    on_connected: Arc<dyn Fn() + Send + Sync>,
}

impl CoreSocket {
    /// `client` must run over [`PinWatch`] built with the same `stop` and `pin_failed`.
    pub fn new(
        client: RealtimeClient,
        tokens: Arc<dyn TokenProvider>,
        watch: &PinWatch,
        latch: Arc<TerminalLatch>,
        on_connected: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            client,
            tokens,
            stop: Arc::clone(&watch.stop),
            latch,
            pin_failed: Arc::clone(&watch.failed),
            on_connected,
        }
    }
}

#[async_trait::async_trait]
impl RealtimeSocket for CoreSocket {
    async fn run(&self) -> SocketEnd {
        let on_connected = || (self.on_connected)();
        let end = socket_run::run(
            &self.client,
            self.tokens.as_ref(),
            &self.stop,
            &self.latch,
            &on_connected,
        )
        .await;
        match end {
            _ if self.pin_failed.load(Ordering::SeqCst) => SocketEnd::PinFailed,
            RunEnd::Stopped => SocketEnd::Stopped,
            RunEnd::Refused => SocketEnd::Refused,
            RunEnd::Terminal => self
                .latch
                .get()
                .map_or(SocketEnd::Stopped, SocketEnd::Terminal),
        }
    }

    fn stop(&self) {
        self.stop.stop();
    }
}

/// The socket's transport: stops the run on the first TLS failure, which on the pinned transport
/// is a pin mismatch (`seams::transport::classify`).
pub struct PinWatch {
    inner: Arc<dyn Transport>,
    stop: Arc<StopSignal>,
    failed: Arc<AtomicBool>,
}

impl PinWatch {
    pub fn new(inner: Arc<dyn Transport>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            stop: Arc::default(),
            failed: Arc::default(),
        })
    }

    fn tripped(stop: &StopSignal, failed: &AtomicBool, error: &TransportError) {
        if matches!(error, TransportError::Tls { .. }) && !failed.swap(true, Ordering::SeqCst) {
            tracing::error!(%error, "SECURITY: the sync socket failed its certificate check; it stays closed until restart");
            stop.stop();
        }
    }
}

#[async_trait::async_trait]
impl Transport for PinWatch {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.inner.send(request).await
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        let watched = Arc::new(Watched {
            inner: listener,
            stop: Arc::clone(&self.stop),
            failed: Arc::clone(&self.failed),
        });
        self.inner
            .open_socket(request, watched)
            .inspect_err(|error| Self::tripped(&self.stop, &self.failed, error))
    }
}

struct Watched {
    inner: Arc<dyn SocketListener>,
    stop: Arc<StopSignal>,
    failed: Arc<AtomicBool>,
}

impl SocketListener for Watched {
    fn on_open(&self) {
        self.inner.on_open();
    }
    fn on_message(&self, payload: Vec<u8>) {
        self.inner.on_message(payload);
    }
    fn on_closed(&self, code: u16, reason: String) {
        self.inner.on_closed(code, reason);
    }
    fn on_error(&self, error: TransportError) {
        PinWatch::tripped(&self.stop, &self.failed, &error);
        self.inner.on_error(error);
    }
}
