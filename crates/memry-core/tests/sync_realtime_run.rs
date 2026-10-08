//! The realtime driver (#2798): what keeps a foreground phone's socket open
//! and turns every frame and every reconnect into a pass.
//!
//! The socket is a fake that records handshakes, frames sent and closes; the
//! test plays the shell, delivering opens, frames and closes on the listener
//! the core installed. Time is paused, so the ladder's and the keepalive's
//! waits are exact.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::http::{ClientIdentity, TokenProvider};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::socket::{Hint, HintSink, KEEPALIVE_FRAME, RealtimeClient};
use memry_core::sync::socket_run::{RunEnd, StopSignal, run};

#[derive(Default)]
struct Socket {
    listeners: Mutex<Vec<Arc<dyn SocketListener>>>,
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    closes: Arc<AtomicUsize>,
}

impl Socket {
    fn opened(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }
    fn latest(&self) -> Arc<dyn SocketListener> {
        self.listeners
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a socket")
    }
}

#[async_trait::async_trait]
impl Transport for Socket {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        unreachable!("the driver makes no HTTP request")
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.listeners.lock().unwrap().push(listener);
        Ok(Arc::new(Handle {
            sent: Arc::clone(&self.sent),
            closes: Arc::clone(&self.closes),
        }))
    }
}

struct Handle {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    closes: Arc<AtomicUsize>,
}

impl SocketHandle for Handle {
    fn send(&self, payload: Vec<u8>) -> Result<(), TransportError> {
        self.sent.lock().unwrap().push(payload);
        Ok(())
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
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

/// Counts the passes the socket asked for: hints plus reconnects.
#[derive(Default)]
struct Passes(AtomicUsize);

impl Passes {
    fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
    fn ask(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl HintSink for Passes {
    fn hint(&self, hint: Hint) {
        if matches!(hint, Hint::ChangesAvailable { .. }) {
            self.ask();
        }
    }
}

struct Harness {
    socket: Arc<Socket>,
    passes: Arc<Passes>,
    stop: Arc<StopSignal>,
    running: tokio::task::JoinHandle<RunEnd>,
}

fn start() -> Harness {
    let socket = Arc::new(Socket::default());
    let passes = Arc::new(Passes::default());
    let stop = Arc::new(StopSignal::default());
    let client = RealtimeClient::new(
        Arc::clone(&socket) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("identity"),
        Arc::new(Tokens),
        Arc::clone(&passes) as Arc<dyn HintSink>,
    );
    let running = {
        let passes = Arc::clone(&passes);
        let stop = Arc::clone(&stop);
        tokio::spawn(async move { run(&client, &Tokens, &stop, &|| passes.ask()).await })
    };
    Harness {
        socket,
        passes,
        stop,
        running,
    }
}

/// Lets the driver run until it waits on something.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

#[tokio::test(start_paused = true)]
async fn a_broadcast_while_open_asks_for_a_pass_at_once() {
    let h = start();
    settle().await;
    assert_eq!(h.socket.opened(), 1, "run opens the socket");

    h.socket.latest().on_open();
    settle().await;
    assert_eq!(h.passes.count(), 1, "an open catches up on what was missed");

    h.socket
        .latest()
        .on_message(br#"{"type":"changes_available","payload":{"cursor":9}}"#.to_vec());
    assert_eq!(
        h.passes.count(),
        2,
        "a broadcast asks for a pass immediately"
    );

    h.stop.stop();
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
    assert_eq!(
        h.socket.closes.load(Ordering::SeqCst),
        1,
        "stop closes the socket"
    );
}

#[tokio::test(start_paused = true)]
async fn a_dropped_socket_reconnects_and_pulls_again() {
    let h = start();
    settle().await;
    h.socket.latest().on_open();
    settle().await;

    h.socket.latest().on_error(TransportError::Offline);
    settle().await;
    assert_eq!(h.socket.opened(), 1, "the ladder waits before reconnecting");
    tokio::time::sleep(Duration::from_millis(1_600)).await;
    assert_eq!(h.socket.opened(), 2, "reconnected after the first rung");

    h.socket.latest().on_open();
    settle().await;
    assert_eq!(h.passes.count(), 2, "every reconnect asks for a pass");

    h.stop.stop();
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
}

#[tokio::test(start_paused = true)]
async fn a_silent_socket_is_pinged_then_dropped_and_replaced() {
    let h = start();
    settle().await;
    h.socket.latest().on_open();
    settle().await;

    tokio::time::sleep(Duration::from_millis(25_100)).await;
    assert_eq!(
        h.socket.sent.lock().unwrap().as_slice(),
        [KEEPALIVE_FRAME.to_vec()]
    );

    // No `pong` ever arrives: the next beat finds the socket half-open.
    tokio::time::sleep(Duration::from_millis(25_000 + 1_600)).await;
    assert_eq!(
        h.socket.closes.load(Ordering::SeqCst),
        1,
        "the stale socket is closed"
    );
    assert_eq!(h.socket.opened(), 2, "and replaced");

    h.stop.stop();
    h.running.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_revoked_device_stops_for_good() {
    let h = start();
    settle().await;
    h.socket.latest().on_closed(4004, "revoked".to_owned());
    assert_eq!(h.running.await.unwrap(), RunEnd::Terminal);
    assert_eq!(h.socket.opened(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_stop_before_the_run_starts_opens_nothing() {
    let socket = Arc::new(Socket::default());
    let stop = StopSignal::default();
    stop.stop();
    let client = RealtimeClient::new(
        Arc::clone(&socket) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("identity"),
        Arc::new(Tokens),
        Arc::new(Passes::default()),
    );
    assert_eq!(run(&client, &Tokens, &stop, &|| {}).await, RunEnd::Stopped);
    assert_eq!(socket.opened(), 0);
}
