//! The realtime hint client and the bootstrap session, against real adapters
//! (chapters 09 and 10).
//!
//! Real `HttpClient`, real SQLite, real `RealtimeClient`. The only fake is the
//! `Transport`, which here answers HTTP **and** hands the core a socket, so
//! the listener the core installs is the one a shell would call into.
//!
//! | Test                                  | Rule                              |
//! | ------------------------------------- | --------------------------------- |
//! | one hint, exactly one pull            | chapter 09 §9.11, §C.3            |
//! | a covered wake is dropped, coalesced  | §9.11, #2290                      |
//! | the socket carries no data            | chapter 09's opening, §9.11       |
//! | 4004 and 4009 latch off               | §9.9                              |
//! | 4003 refreshes before reconnecting    | §9.10.1                           |
//! | a 501 open falls back silently        | chapter 10 §10.5, §10.12          |
//! | a failed renewal drops the header     | §10.11 (Q10.2), mid-run           |

mod http_fakes;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, error_response, response};
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{
    BOOTSTRAP_TOKEN_HEADER, ClientIdentity, HttpClient, TokenProvider,
};
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::{Db, open_data};
use memry_core::sync::bootstrap::{BOOTSTRAP_RENEW_LEAD_SECONDS, BootstrapClient, SessionState};
use memry_core::sync::engine::SyncEngine;
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::socket::{
    APP_VERSION_HEADER, CLOSE_DEVICE_REVOKED, CLOSE_RATE_LIMITED, CLOSE_TOKEN_EXPIRED,
    CLOSE_VERSION_INCOMPATIBLE, Hint, HintSink, KEEPALIVE_FRAME, RealtimeClient, Reconnect,
    Terminal,
};
use memry_core::sync::state::PassTrigger;
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::json;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-realtime-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

// ------------------------------------------------- a transport with a socket

/// A transport that answers HTTP from a script **and** hands out a socket,
/// keeping the listener the core installed so a test can deliver frames the
/// way a shell would.
struct SocketTransport {
    http: Arc<FakeTransport>,
    listener: Mutex<Option<Arc<dyn SocketListener>>>,
    handshakes: Mutex<Vec<SocketRequest>>,
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    closes: Arc<AtomicUsize>,
}

impl SocketTransport {
    fn new(script: Vec<Result<HttpResponse, TransportError>>) -> Arc<Self> {
        Arc::new(Self {
            http: FakeTransport::new(script),
            listener: Mutex::new(None),
            handshakes: Mutex::new(Vec::new()),
            sent: Arc::new(Mutex::new(Vec::new())),
            closes: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn listener(&self) -> Arc<dyn SocketListener> {
        self.listener
            .lock()
            .unwrap()
            .clone()
            .expect("the core opened a socket")
    }

    fn handshake(&self) -> SocketRequest {
        self.handshakes.lock().unwrap()[0].clone()
    }

    fn sent(&self) -> Vec<Vec<u8>> {
        self.sent.lock().unwrap().clone()
    }

    fn http_calls_to(&self, suffix: &str) -> Vec<HttpRequest> {
        self.http.calls_to(suffix)
    }

    fn http_call_count(&self) -> usize {
        self.http.call_count()
    }
}

#[async_trait::async_trait]
impl Transport for SocketTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.http.send(request).await
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.handshakes.lock().unwrap().push(request);
        *self.listener.lock().unwrap() = Some(listener);
        Ok(Arc::new(RecordingHandle {
            sent: Arc::clone(&self.sent),
            closes: Arc::clone(&self.closes),
        }))
    }
}

struct RecordingHandle {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    closes: Arc<AtomicUsize>,
}

impl SocketHandle for RecordingHandle {
    fn send(&self, payload: Vec<u8>) -> Result<(), TransportError> {
        self.sent.lock().unwrap().push(payload);
        Ok(())
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::Relaxed);
    }
}

// ------------------------------------------------------------- other fakes

struct FixedTokens(&'static str, AtomicUsize);

impl FixedTokens {
    fn new() -> Arc<Self> {
        Arc::new(Self("access-token", AtomicUsize::new(0)))
    }
    fn refreshes(&self) -> usize {
        self.1.load(Ordering::Relaxed)
    }
}

#[async_trait::async_trait]
impl TokenProvider for FixedTokens {
    async fn access_token(&self) -> Option<String> {
        Some(self.0.to_owned())
    }
    async fn refresh(&self, _stale: &str) -> Result<String, ApiError> {
        self.1.fetch_add(1, Ordering::Relaxed);
        Ok(self.0.to_owned())
    }
}

/// Every hint the socket produced.
#[derive(Default)]
struct RecordedHints(Mutex<Vec<Hint>>);

impl RecordedHints {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn seen(&self) -> Vec<Hint> {
        self.0.lock().unwrap().clone()
    }
}

impl HintSink for RecordedHints {
    fn hint(&self, hint: Hint) {
        self.0.lock().unwrap().push(hint);
    }
}

struct NeverFails;

impl RecordCipher for NeverFails {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(br#"{"title":"x"}"#.to_vec())
    }
}

struct AlwaysOnline;

impl Reachability for AlwaysOnline {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

fn identity() -> ClientIdentity {
    ClientIdentity::new("ios", "1.2.3").expect("a valid identity")
}

fn realtime(transport: Arc<SocketTransport>, sink: Arc<RecordedHints>) -> RealtimeClient {
    RealtimeClient::new(
        transport,
        "https://sync.example",
        identity(),
        FixedTokens::new(),
        sink,
    )
}

// ------------------------------------------------------------- the tests

#[tokio::test]
async fn one_hint_triggers_exactly_one_pull_and_carries_no_data() {
    let db = scratch_db("hint");
    // The pull the hint causes: one empty page and nothing else. A second
    // pass would run off the end of this script and panic, which is how "one
    // pull" is asserted rather than asserted about.
    let transport = SocketTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 7}).to_string(),
        ),
    ]);
    let hints = RecordedHints::new();
    let socket = realtime(Arc::clone(&transport), Arc::clone(&hints));
    socket.connect().await.expect("connect");

    // §9.2: handshake headers only, and `X-App-Version` is not optional.
    let handshake = transport.handshake();
    assert_eq!(handshake.url, "wss://sync.example/sync/ws");
    assert_eq!(
        handshake
            .headers
            .get(APP_VERSION_HEADER)
            .map(String::as_str),
        Some("1.2.3")
    );
    assert!(handshake.headers.contains_key("authorization"));
    assert!(
        !handshake.url.contains("token"),
        "§9.2: never a query parameter"
    );

    // One frame arrives, the way the Durable Object broadcasts it — carrying
    // a cursor the client must not use (§9.11).
    transport.listener().on_open();
    transport.listener().on_message(
        serde_json::to_vec(&json!({"type": "crdt_updated", "payload": {"noteId": "abc123def456"}}))
            .expect("frame"),
    );

    assert_eq!(
        hints.seen(),
        vec![Hint::CrdtUpdated {
            note_id: "abc123def456".into(),
            vault_id: None
        }],
        "exactly one hint, and it is an id — never bytes"
    );

    // The hint is what drives the pull; the socket delivered none of the data.
    let http = Arc::new(HttpClient::new(
        Arc::clone(&transport) as Arc<dyn Transport>,
        "https://sync.example",
        identity(),
    ));
    let pull = Arc::new(PullLoop::new(
        http.clone(),
        db,
        Declaration::subscribed(),
        Arc::new(NeverFails),
    ));
    let engine = SyncEngine::new(pull, http, Arc::new(AlwaysOnline));
    let report = engine.run_pass(PassTrigger::SocketHint).await;

    assert_eq!(report.pull.pages, 1);
    assert_eq!(transport.http_calls_to("&limit=500").len(), 0);
    assert_eq!(
        transport.http_calls_to("/sync/changes?limit=500").len(),
        1,
        "one hint, one pull"
    );
    assert_eq!(transport.http_call_count(), 2, "status poll plus the page");
}

/// An engine over `transport`, with the pull loop reading `db`.
fn wake_engine(transport: Arc<FakeTransport>, db: Db) -> Arc<SyncEngine> {
    let http = Arc::new(HttpClient::new(
        transport as Arc<dyn Transport>,
        "https://sync.example",
        identity(),
    ));
    let pull = Arc::new(PullLoop::new(
        http.clone(),
        db,
        Declaration::subscribed(),
        Arc::new(NeverFails),
    ));
    Arc::new(SyncEngine::new(pull, http, Arc::new(AlwaysOnline)))
}

fn empty_page(next_cursor: i64) -> Result<HttpResponse, TransportError> {
    response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": next_cursor})
            .to_string(),
    )
}

fn stored_cursor(db: &Db) -> Option<String> {
    db.call_blocking(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
        .expect("read the cursor")
}

/// #2290: a wake whose cursor this device already applied costs no request,
/// and a wake past it pulls to the page's `nextCursor`, never to its own.
#[tokio::test]
async fn a_wake_at_or_below_the_applied_cursor_runs_no_pass_and_is_never_stored() {
    let db = scratch_db("wake-filter");
    db.call_blocking(|conn| store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some("40"), 1))
        .expect("seed the applied cursor");
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        empty_page(45),
        empty_page(46),
    ]);
    let engine = wake_engine(Arc::clone(&transport), db.clone());

    assert!(engine.wake(Some(40)).await.is_none(), "equal is covered");
    assert!(engine.wake(Some(12)).await.is_none(), "below is covered");
    assert_eq!(transport.call_count(), 0, "a dropped wake sends nothing");

    let report = engine.wake(Some(99)).await.expect("a wake past the cursor");
    assert_eq!(report.pull.pages, 1);
    assert_eq!(
        stored_cursor(&db).as_deref(),
        Some("45"),
        "§9.11: the page's nextCursor is stored, never the wake's 99"
    );

    // §9.11: a broadcast without a cursor is still a wake.
    assert!(engine.wake(None).await.is_some());
    assert_eq!(stored_cursor(&db).as_deref(), Some("46"));
}

/// #2290: any number of wakes during a running pass queue exactly one
/// trailing pass, not one pass each.
#[tokio::test]
async fn wakes_during_a_running_pass_coalesce_into_one_trailing_pass() {
    let db = scratch_db("wake-coalesce");
    // Every response pauses, so the first pass holds the gate while the
    // wakes arrive. A third pass would run off the script and panic.
    let transport = FakeTransport::slow(
        vec![
            response(
                200,
                &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
            ),
            empty_page(50),
            empty_page(60),
        ],
        50,
    );
    let engine = wake_engine(Arc::clone(&transport), db.clone());

    let running = tokio::spawn({
        let engine = Arc::clone(&engine);
        async move { engine.run_pass(PassTrigger::Timer).await }
    });
    tokio::task::yield_now().await;

    let wakes: Vec<_> = (0..10)
        .map(|_| {
            let engine = Arc::clone(&engine);
            tokio::spawn(async move { engine.wake(None).await })
        })
        .collect();
    running.await.expect("the running pass");
    let mut ran = 0;
    for wake in wakes {
        if wake.await.expect("a wake").is_some() {
            ran += 1;
        }
    }

    assert_eq!(ran, 1, "ten wakes during a pass, one trailing pass");
    assert_eq!(transport.call_count(), 3, "one status poll and two pages");
    assert_eq!(stored_cursor(&db).as_deref(), Some("60"));
}

/// A wake cancelled while it waited for the gate must not leave the queued
/// flag set, or every later wake would be swallowed (#2290).
#[tokio::test]
async fn a_cancelled_queued_wake_does_not_swallow_later_wakes() {
    let db = scratch_db("wake-cancel");
    let transport = FakeTransport::slow(
        vec![
            response(
                200,
                &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
            ),
            empty_page(70),
            empty_page(80),
        ],
        50,
    );
    let engine = wake_engine(Arc::clone(&transport), db.clone());

    let running = tokio::spawn({
        let engine = Arc::clone(&engine);
        async move { engine.run_pass(PassTrigger::Timer).await }
    });
    tokio::task::yield_now().await;

    let cancelled =
        tokio::time::timeout(std::time::Duration::from_millis(5), engine.wake(None)).await;
    assert!(
        cancelled.is_err(),
        "the wake was still queued behind the pass"
    );
    running.await.expect("the running pass");

    assert!(
        engine.wake(None).await.is_some(),
        "the cancelled wake released its queued slot"
    );
    assert_eq!(stored_cursor(&db).as_deref(), Some("80"));
}

#[tokio::test]
async fn the_keepalive_is_exactly_ping_and_a_reauth_is_sent_in_place() {
    let transport = SocketTransport::new(vec![]);
    let socket = realtime(Arc::clone(&transport), RecordedHints::new());
    socket.connect().await.expect("connect");

    socket.ping().expect("ping");
    socket.reauthenticate().await.expect("reauth");

    let sent = transport.sent();
    // §9.6: Cloudflare answers this one payload without waking the object.
    // Any other text costs a wake on every beat.
    assert_eq!(sent[0], KEEPALIVE_FRAME.to_vec());
    // §9.8: re-authenticate in place rather than tearing the socket down.
    let frame: serde_json::Value = serde_json::from_slice(&sent[1]).expect("json");
    assert_eq!(frame["type"], "auth");
    assert!(frame["payload"]["token"].is_string());

    // The keepalive answer is not a hint and is not a parse failure.
    transport.listener().on_message(b"pong".to_vec());
}

#[tokio::test]
async fn the_two_terminal_close_codes_latch_reconnection_off() {
    for (code, expected) in [
        (CLOSE_DEVICE_REVOKED, Terminal::DeviceRevoked),
        (CLOSE_VERSION_INCOMPATIBLE, Terminal::VersionIncompatible),
    ] {
        let transport = SocketTransport::new(vec![]);
        let socket = realtime(Arc::clone(&transport), RecordedHints::new());
        socket.connect().await.expect("connect");
        transport.listener().on_open();
        transport.listener().on_closed(code, "gone".to_owned());

        assert_eq!(socket.note_closed(), Reconnect::Terminal(expected));
        assert_eq!(socket.terminal(), Some(expected));
        // §9.9: the latch holds for the session, so a later connect refuses
        // rather than opening a second socket the server will kill anyway.
        assert!(socket.connect().await.is_err());
        // Asking twice does not clear it.
        assert_eq!(socket.note_closed(), Reconnect::Terminal(expected));
    }
}

#[tokio::test]
async fn a_4003_refreshes_first_and_a_4008_walks_the_ladder() {
    let transport = SocketTransport::new(vec![]);
    let socket = realtime(Arc::clone(&transport), RecordedHints::new());
    socket.connect().await.expect("connect");
    transport.listener().on_open();

    // §9.10.1: the same expired token yields another 4003 and burns an
    // attempt, so the refresh comes first and the counter resets.
    transport
        .listener()
        .on_closed(CLOSE_TOKEN_EXPIRED, "expired".to_owned());
    assert_eq!(socket.note_closed(), Reconnect::AfterRefresh);

    // An ordinary reconnectable close walks §9.10's ladder from zero, because
    // the 4003 reset it.
    transport
        .listener()
        .on_closed(CLOSE_RATE_LIMITED, "slow down".to_owned());
    let Reconnect::After { delay_ms } = socket.note_closed() else {
        panic!("4008 is reconnectable");
    };
    assert!((1_000..=1_500).contains(&delay_ms), "base plus jitter");

    transport
        .listener()
        .on_closed(CLOSE_RATE_LIMITED, "slow down".to_owned());
    let Reconnect::After { delay_ms } = socket.note_closed() else {
        panic!("still reconnectable");
    };
    assert!((2_000..=2_500).contains(&delay_ms), "the attempt doubled");

    // §9.10: a successful open resets the attempt counter.
    transport.listener().on_open();
    transport
        .listener()
        .on_closed(CLOSE_RATE_LIMITED, "slow down".to_owned());
    let Reconnect::After { delay_ms } = socket.note_closed() else {
        panic!("still reconnectable");
    };
    assert!((1_000..=1_500).contains(&delay_ms), "back to the base");

    // §9.1: a backgrounded client closes, and a close it asked for is not
    // reconnected into.
    socket.disconnect();
    assert_eq!(socket.note_closed(), Reconnect::Stopped);
}

fn bootstrap(
    script: Vec<Result<HttpResponse, TransportError>>,
) -> (Arc<FakeTransport>, BootstrapClient) {
    let transport = FakeTransport::new(script);
    let http = Arc::new(HttpClient::new(
        Arc::clone(&transport) as Arc<dyn Transport>,
        "https://sync.example",
        identity(),
    ));
    (transport, BootstrapClient::new(http))
}

#[tokio::test]
async fn a_501_open_falls_back_silently_and_is_not_retried() {
    // §10.12: the deployment has no HMAC key. That is a configuration fact,
    // not a client bug, and §0.6.1 keeps 501 out of the retryable 5xx set.
    let (transport, client) = bootstrap(vec![error_response(
        501,
        "BOOTSTRAP_UNAVAILABLE",
        "no bootstrap key",
    )]);

    let opened = client.open(1_000).await;
    assert!(!opened.elevated());
    assert_eq!(opened.tail_cursor, 0);
    assert!(opened.fallback_reason.is_some());
    assert_eq!(transport.call_count(), 1, "one attempt, no ladder");
    assert_eq!(client.state(), SessionState::SteadyState);
    // §10.7: no header, so every request is paced at steady state.
    assert_eq!(client.header(1_000), None);

    // §10.11 rule 3: the window is one-shot, so a second open is refused
    // locally rather than earning a 409.
    let again = client.open(2_000).await;
    assert!(!again.elevated());
    assert_eq!(transport.call_count(), 1);
}

#[tokio::test]
async fn a_first_sync_that_outlives_the_session_drops_the_header_mid_run() {
    // §10.11 (Q10.2): the absolute lifetime is six hours, the renewal answers
    // `403 BOOTSTRAP_SESSION_EXPIRED`, and the client treats it as an
    // ordinary rate change.
    let (transport, client) = bootstrap(vec![
        response(
            200,
            &json!({
                "session": {"token": "tok-1", "expiresAt": 4_600, "ttlSeconds": 3_600},
                "tailCursor": 9_001,
                "packs": []
            })
            .to_string(),
        ),
        error_response(403, "BOOTSTRAP_SESSION_EXPIRED", "the window is spent"),
    ]);

    let opened = client.open(1_000).await;
    assert!(opened.elevated());
    assert_eq!(opened.tail_cursor, 9_001, "§10.4: the progress denominator");
    assert_eq!(
        client.header(1_000),
        Some((BOOTSTRAP_TOKEN_HEADER, "tok-1".to_owned()))
    );

    // §10.11 rule 1: not due a second before the lead.
    let lead = 4_600 - BOOTSTRAP_RENEW_LEAD_SECONDS;
    assert!(client.renew_if_due(lead - 1).await);
    assert_eq!(transport.call_count(), 1, "no renewal was sent yet");

    // At the lead the renewal goes out, and it fails terminally.
    assert!(!client.renew_if_due(lead).await);
    assert_eq!(transport.call_count(), 2);

    // The header is gone and the run continues at steady-state pacing. No
    // second session is opened (rule 3), and nothing is reported as a
    // failure: the only observable change is that the rest takes longer.
    assert_eq!(client.header(lead), None);
    assert_eq!(client.state(), SessionState::SteadyState);
    assert!(!client.renew_if_due(lead + 1).await);
    assert_eq!(transport.call_count(), 2);

    // The elevated header is added to a request only while the window is
    // open, and silently dropped afterwards.
    let request = memry_core::protocol::http::ApiRequest::get("/sync/changes");
    let elevated: HashMap<String, String> =
        client.elevate(request, lead).headers.into_iter().collect();
    assert!(!elevated.contains_key(BOOTSTRAP_TOKEN_HEADER));
}

#[tokio::test]
async fn an_expired_token_is_dropped_without_a_round_trip() {
    let (transport, client) = bootstrap(vec![response(
        200,
        &json!({"session": {"token": "tok-1", "expiresAt": 2_000}, "tailCursor": 0}).to_string(),
    )]);
    client.open(1_000).await;

    // §10.8: elevation is stateless and a dead token elevates nothing, so
    // discovering that costs no call.
    assert_eq!(client.header(2_000), None);
    assert_eq!(transport.call_count(), 1);
    assert_eq!(client.state(), SessionState::SteadyState);
}

#[tokio::test]
async fn a_refreshing_token_provider_is_only_asked_once_per_socket_4003() {
    // A guard on §9.10.1 step 2's "single-flighted": the socket client does
    // not refresh on its own, it reports `AfterRefresh` and lets the caller
    // drive the one refresh path the HTTP tier already single-flights.
    let tokens = FixedTokens::new();
    let transport = SocketTransport::new(vec![]);
    let socket = RealtimeClient::new(
        Arc::clone(&transport) as Arc<dyn Transport>,
        "https://sync.example",
        identity(),
        Arc::clone(&tokens) as Arc<dyn TokenProvider>,
        RecordedHints::new(),
    );
    socket.connect().await.expect("connect");
    transport
        .listener()
        .on_closed(CLOSE_TOKEN_EXPIRED, "expired".to_owned());

    assert_eq!(socket.note_closed(), Reconnect::AfterRefresh);
    assert_eq!(tokens.refreshes(), 0);
}
