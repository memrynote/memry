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
use memry_core::sync::socket_run::{RunEnd, StopSignal, TerminalLatch, run};

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

/// Counts refreshes. The token is opaque, so the pre-handshake expiry check
/// cannot parse it and refreshes once per connect; a 4003 adds one more.
#[derive(Default)]
struct Tokens(AtomicUsize);

impl Tokens {
    fn refreshes(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl TokenProvider for Tokens {
    async fn access_token(&self) -> Option<String> {
        Some("token".to_owned())
    }
    async fn refresh(&self, stale: &str) -> Result<String, ApiError> {
        self.0.fetch_add(1, Ordering::SeqCst);
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
    tokens: Arc<Tokens>,
    running: tokio::task::JoinHandle<RunEnd>,
}

fn start() -> Harness {
    start_latched(Arc::new(TerminalLatch::default()))
}

/// A fresh socket and run over `latch`, the way a shell mints one per
/// foreground over one `VaultSync`.
fn start_latched(latch: Arc<TerminalLatch>) -> Harness {
    let socket = Arc::new(Socket::default());
    let passes = Arc::new(Passes::default());
    let stop = Arc::new(StopSignal::default());
    let tokens = Arc::new(Tokens::default());
    let client = RealtimeClient::new(
        Arc::clone(&socket) as Arc<dyn Transport>,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("identity"),
        Arc::clone(&tokens) as Arc<dyn TokenProvider>,
        Arc::clone(&passes) as Arc<dyn HintSink>,
    );
    let running = {
        let passes = Arc::clone(&passes);
        let stop = Arc::clone(&stop);
        let tokens = Arc::clone(&tokens);
        tokio::spawn(
            async move { run(&client, tokens.as_ref(), &stop, &latch, &|| passes.ask()).await },
        )
    };
    Harness {
        socket,
        passes,
        stop,
        tokens,
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
        Arc::new(Tokens::default()),
        Arc::new(Passes::default()),
    );
    let latch = TerminalLatch::default();
    assert_eq!(
        run(&client, &Tokens::default(), &stop, &latch, &|| {}).await,
        RunEnd::Stopped
    );
    assert_eq!(socket.opened(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_terminal_close_latches_every_later_socket_off() {
    for code in [4004, 4009] {
        let latch = Arc::new(TerminalLatch::default());
        let first = start_latched(Arc::clone(&latch));
        settle().await;
        first.socket.latest().on_closed(code, "terminal".to_owned());
        assert_eq!(first.running.await.unwrap(), RunEnd::Terminal);

        // The next foreground mints a new socket over the same latch.
        let next = start_latched(latch);
        let end = tokio::time::timeout(Duration::from_secs(1), next.running)
            .await
            .expect("a latched run returns without waiting on a socket");
        assert_eq!(end.unwrap(), RunEnd::Terminal, "{code}");
        assert_eq!(
            next.socket.opened(),
            0,
            "{code}: no handshake after the latch"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_4003_refreshes_the_token_then_reconnects_at_once() {
    let h = start();
    settle().await;
    h.socket.latest().on_open();
    settle().await;
    let before = h.tokens.refreshes();

    h.socket
        .latest()
        .on_closed(4003, "token expired".to_owned());
    settle().await;
    assert_eq!(h.socket.opened(), 2, "reconnected without waiting a rung");
    assert_eq!(
        h.tokens.refreshes(),
        before + 2,
        "the 4003 refresh, then the pre-handshake one"
    );

    h.stop.stop();
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
}

#[tokio::test(start_paused = true)]
async fn a_stop_while_open_ends_the_run_and_closes() {
    let h = start();
    settle().await;
    h.socket.latest().on_open();
    settle().await;

    h.stop.stop();
    settle().await;
    assert!(h.running.is_finished(), "stop wakes the hold at once");
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
    assert_eq!(h.socket.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_stop_during_backoff_ends_the_run_without_reconnecting() {
    let h = start();
    settle().await;
    h.socket.latest().on_error(TransportError::Offline);
    settle().await;

    h.stop.stop();
    settle().await;
    assert!(h.running.is_finished(), "stop cuts the backoff short");
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(h.socket.opened(), 1, "no reconnect after the stop");
}

#[tokio::test(start_paused = true)]
async fn a_late_close_from_a_replaced_socket_is_ignored() {
    let h = start();
    settle().await;
    let old = h.socket.latest();
    old.on_error(TransportError::Offline);
    tokio::time::sleep(Duration::from_millis(1_600)).await;
    assert_eq!(h.socket.opened(), 2);
    h.socket.latest().on_open();
    settle().await;

    // The first socket's close lands after its replacement opened, carrying
    // a terminal code: it must neither end nor latch the live socket.
    old.on_closed(4004, "late".to_owned());
    old.on_message(br#"{"type":"changes_available","payload":{"cursor":1}}"#.to_vec());
    settle().await;
    assert!(!h.running.is_finished(), "the live socket is still held");
    assert_eq!(h.passes.count(), 1, "only the live open asked for a pass");

    h.stop.stop();
    assert_eq!(h.running.await.unwrap(), RunEnd::Stopped);
}
