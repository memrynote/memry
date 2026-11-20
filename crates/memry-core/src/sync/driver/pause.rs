//! The driver's pause, and the cut it makes in the pass in flight.
//!
//! A pause ends the running pass at its next request, as Electron's pause
//! aborts its run (`engine.ts:663-668`): while paused, every request of the
//! driver's own [`HttpClient`] answers [`TransportError::Cancelled`], the one
//! in flight included, and a retry's sleep ends early. The pass itself is
//! never dropped at an await. A path that took state into memory (the due
//! snapshots, the missed signers) meets an error and puts the state back, as
//! it does when the network drops, and a page that committed still tells its
//! observers.

use std::sync::Arc;

use tokio::sync::watch;

use crate::api::errors::TransportError;
use crate::protocol::http::{HttpClient, Sleeper, TokenProvider};
use crate::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};

use super::SyncDriver;

/// Whether the driver is paused. Its requests watch it.
pub(super) struct PauseSwitch(watch::Sender<bool>);

impl Default for PauseSwitch {
    fn default() -> Self {
        Self(watch::Sender::new(false))
    }
}

impl PauseSwitch {
    /// The session's client over a transport and a sleeper this switch cuts.
    pub(super) fn client(
        &self,
        session: &HttpClient,
        tokens: Arc<dyn TokenProvider>,
    ) -> HttpClient {
        HttpClient::new(
            Arc::new(CutTransport {
                inner: session.transport(),
                paused: self.0.subscribe(),
            }),
            session.base_url(),
            session.identity().clone(),
        )
        .with_tokens(tokens)
        .with_sleeper(Arc::new(CutSleeper(self.0.subscribe())))
    }
}

impl SyncDriver {
    /// Stops passes and first syncs until [`SyncDriver::resume`], and cuts
    /// the pass in flight at its next request.
    pub fn pause(&self) {
        self.pause.0.send_replace(true);
    }

    pub fn resume(&self) {
        self.pause.0.send_replace(false);
    }

    pub(super) fn is_paused(&self) -> bool {
        *self.pause.0.borrow()
    }
}

/// Returns once paused; never when the switch is gone with its driver.
async fn until_paused(paused: &watch::Receiver<bool>) {
    let mut paused = paused.clone();
    if paused.wait_for(|paused| *paused).await.is_err() {
        std::future::pending::<()>().await;
    }
}

struct CutTransport {
    inner: Arc<dyn Transport>,
    paused: watch::Receiver<bool>,
}

#[async_trait::async_trait]
impl Transport for CutTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        tokio::select! {
            biased;
            () = until_paused(&self.paused) => Err(TransportError::Cancelled),
            sent = self.inner.send(request) => sent,
        }
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.inner.open_socket(request, listener)
    }
}

struct CutSleeper(watch::Receiver<bool>);

#[async_trait::async_trait]
impl Sleeper for CutSleeper {
    async fn sleep_ms(&self, ms: u64) {
        tokio::select! {
            () = until_paused(&self.0) => {}
            () = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {}
        }
    }
}
