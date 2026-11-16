//! [`CoreSocket`] over [`PinWatch`] on a fake transport: a TLS failure on the handshake or on the
//! open socket ends the run as `PinFailed`, a refused 403 ends it as `HandshakeForbidden`, and
//! anything else takes the ladder until stopped. Paused clock.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::http::{ClientIdentity, TokenProvider};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::socket::{Hint, HintSink, RealtimeClient, Terminal};
use memry_core::sync::socket_run::TerminalLatch;

use super::*;

/// Answers the first handshake with `refuse`, or opens and keeps the listener.
struct Fake {
    refuse: Option<TransportError>,
    listeners: Mutex<Vec<Arc<dyn SocketListener>>>,
}

#[async_trait::async_trait]
impl Transport for Fake {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        unreachable!("the socket makes no HTTP request")
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        if let Some(error) = &self.refuse {
            return Err(error.clone());
        }
        crate::session::lock(&self.listeners).push(listener);
        Ok(Arc::new(Handle))
    }
}

struct Handle;

impl SocketHandle for Handle {
    fn send(&self, _payload: Vec<u8>) -> Result<(), TransportError> {
        Ok(())
    }
    fn close(&self) {}
}

struct Tokens;

#[async_trait::async_trait]
impl TokenProvider for Tokens {
    async fn access_token(&self) -> Option<String> {
        Some("token".to_owned())
    }
    async fn refresh(&self, stale: &str) -> Result<String, ApiError> {
        Ok(stale.to_owned())
    }
}

struct Nowhere;

impl HintSink for Nowhere {
    fn hint(&self, _hint: Hint) {}
}

struct Running {
    fake: Arc<Fake>,
    socket: Arc<CoreSocket>,
    latch: Arc<TerminalLatch>,
    run: tokio::task::JoinHandle<SocketEnd>,
}

fn start(refuse: Option<TransportError>) -> Running {
    let fake = Arc::new(Fake {
        refuse,
        listeners: Mutex::default(),
    });
    let watch = PinWatch::new(Arc::clone(&fake) as Arc<dyn Transport>);
    let client = RealtimeClient::new(
        Arc::clone(&watch) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").unwrap(),
        Arc::new(Tokens),
        Arc::new(Nowhere),
    );
    let latch = Arc::new(TerminalLatch::default());
    let socket = Arc::new(CoreSocket::new(
        client,
        Arc::new(Tokens),
        &watch,
        Arc::clone(&latch),
        Arc::new(|| {}),
    ));
    let running = Arc::clone(&socket);
    let run = tokio::spawn(async move { running.run().await });
    Running {
        fake,
        socket,
        latch,
        run,
    }
}

fn tls() -> TransportError {
    TransportError::Tls {
        what: "pin mismatch".into(),
    }
}

/// Lets the run reach its next wait.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// Ends the run; a run the test expected to end on its own must not need this.
async fn end(running: Running) -> SocketEnd {
    tokio::time::timeout(Duration::from_secs(600), running.run)
        .await
        .expect("the run ended")
        .unwrap()
}

#[tokio::test(start_paused = true)]
async fn a_tls_failure_on_the_handshake_ends_the_run_as_pin_failed() {
    let running = start(Some(tls()));
    assert_eq!(end(running).await, SocketEnd::PinFailed);
}

#[tokio::test(start_paused = true)]
async fn a_tls_failure_on_an_open_socket_ends_the_run_as_pin_failed() {
    let running = start(None);
    settle().await;
    let listener = crate::session::lock(&running.fake.listeners)[0].clone();
    listener.on_open();
    listener.on_error(tls());
    assert_eq!(end(running).await, SocketEnd::PinFailed);
}

#[tokio::test(start_paused = true)]
async fn a_handshake_refused_403_ends_the_run_without_claiming_revocation() {
    let running = start(None);
    settle().await;
    let listener = crate::session::lock(&running.fake.listeners)[0].clone();
    listener.on_error(TransportError::HandshakeRejected { status: 403 });
    let latch = Arc::clone(&running.latch);
    assert_eq!(
        end(running).await,
        SocketEnd::Terminal(Terminal::HandshakeForbidden)
    );
    assert_eq!(latch.get(), Some(Terminal::HandshakeForbidden));
}

#[tokio::test(start_paused = true)]
async fn another_failure_takes_the_ladder_until_stopped() {
    let running = start(None);
    settle().await;
    let listener = crate::session::lock(&running.fake.listeners)[0].clone();
    listener.on_error(TransportError::HandshakeRejected { status: 503 });
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(
        crate::session::lock(&running.fake.listeners).len() > 1,
        "reconnected"
    );
    running.socket.stop();
    assert_eq!(end(running).await, SocketEnd::Stopped);
}
