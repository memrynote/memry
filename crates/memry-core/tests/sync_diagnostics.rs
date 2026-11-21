//! What a run tells the shell's log about its requests (#5215): the retry
//! ladder's statistics per phase, the interim snapshot of a phase that never
//! ends, and how the bootstrap open answered.
//!
//! Real `HttpClient`, `RunDiagnostics` and `BootstrapClient`; the transport and
//! the sleeper are the scripted fakes, so what is asserted is what a sink
//! receives for a given server.

mod http_fakes;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_fakes::*;
use memry_core::api::errors::TransportError;
use memry_core::protocol::http::{ApiRequest, ClientIdentity, HttpClient};
use memry_core::seams::diagnostics::{
    BootstrapOutcome, CoreDiagnostic, DiagnosticPhase, DiagnosticsSink, RequestStats,
};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::bootstrap::BootstrapClient;
use memry_core::sync::diagnostics::{INTERIM_INTERVAL, RunDiagnostics};

#[derive(Default)]
struct Captured(Mutex<Vec<CoreDiagnostic>>);

impl Captured {
    fn events(&self) -> Vec<CoreDiagnostic> {
        self.0.lock().unwrap().clone()
    }
}

impl DiagnosticsSink for Captured {
    fn record(&self, event: CoreDiagnostic) {
        self.0.lock().unwrap().push(event);
    }
}

fn client(transport: Arc<dyn Transport>, sleeper: Arc<RecordingSleeper>) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(
            transport,
            "https://sync.example.com",
            ClientIdentity::new("ios", "1.4.2").unwrap(),
        )
        .with_sleeper(sleeper),
    )
}

fn recorder() -> (Arc<Captured>, Arc<RunDiagnostics>) {
    let sink = Arc::new(Captured::default());
    let diagnostics = RunDiagnostics::new(sink.clone());
    (sink, diagnostics)
}

/// The statistics of the one final `PhaseStats` the sink received.
fn only_final(sink: &Captured, expected: DiagnosticPhase) -> RequestStats {
    let finals: Vec<RequestStats> = sink
        .events()
        .into_iter()
        .filter_map(|event| match event {
            CoreDiagnostic::PhaseStats {
                phase,
                finished: true,
                requests,
                ..
            } if phase == expected => Some(requests),
            _ => None,
        })
        .collect();
    assert_eq!(finals.len(), 1, "{:?}", sink.events());
    finals[0]
}

/// Answers each request after its own scripted wire time. Under a paused
/// clock the wait is exact, so percentiles are exact too.
struct TimedTransport {
    script: Mutex<Vec<(u64, Result<HttpResponse, TransportError>)>>,
}

impl TimedTransport {
    fn new(script: Vec<(u64, Result<HttpResponse, TransportError>)>) -> Arc<Self> {
        let mut script = script;
        script.reverse();
        Arc::new(Self {
            script: Mutex::new(script),
        })
    }
}

#[async_trait::async_trait]
impl Transport for TimedTransport {
    async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let (wire_ms, answer) = self
            .script
            .lock()
            .unwrap()
            .pop()
            .expect("a scripted answer");
        tokio::time::sleep(Duration::from_millis(wire_ms)).await;
        answer
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        unreachable!("no sockets here")
    }
}

#[tokio::test(start_paused = true)]
async fn a_429_then_200_counts_the_retry_the_429_and_the_wait() {
    let transport = FakeTransport::new(vec![
        response_with_header(
            429,
            r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
            ("retry-after", "3"),
        ),
        response(200, "{}"),
    ]);
    let (sink, diagnostics) = recorder();
    let http = diagnostics.observe(&client(transport, RecordingSleeper::new()));

    diagnostics
        .phase(DiagnosticPhase::Refs, async {
            http.send(ApiRequest::get("/sync/changes")).await.unwrap()
        })
        .await;

    assert_eq!(
        only_final(&sink, DiagnosticPhase::Refs),
        RequestStats {
            requests: 2,
            retries: 1,
            rate_limited: 1,
            rate_limit_wait_ms: 3_000,
            ..RequestStats::default()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_5xx_then_200_counts_the_retry_without_a_rate_limit_wait() {
    let transport = FakeTransport::new(vec![
        error_response(503, "INTERNAL_ERROR", "overloaded"),
        response(200, "{}"),
    ]);
    let (sink, diagnostics) = recorder();
    let sleeper = RecordingSleeper::new();
    let http = diagnostics.observe(&client(transport, sleeper.clone()));

    diagnostics
        .phase(DiagnosticPhase::Metadata, async {
            http.send(ApiRequest::post("/sync/pull")).await.unwrap()
        })
        .await;

    assert_eq!(sleeper.slept(), vec![2_000], "the ladder did back off");
    assert_eq!(
        only_final(&sink, DiagnosticPhase::Metadata),
        RequestStats {
            requests: 2,
            retries: 1,
            server_errors: 1,
            ..RequestStats::default()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_dropped_connection_then_200_counts_a_transport_error_and_a_retry() {
    let transport = FakeTransport::new(vec![Err(TransportError::Offline), response(200, "{}")]);
    let (sink, diagnostics) = recorder();
    let http = diagnostics.observe(&client(transport, RecordingSleeper::new()));

    diagnostics
        .phase(DiagnosticPhase::Refs, async {
            http.send(ApiRequest::get("/sync/changes")).await.unwrap()
        })
        .await;

    assert_eq!(
        only_final(&sink, DiagnosticPhase::Refs),
        RequestStats {
            requests: 2,
            retries: 1,
            transport_errors: 1,
            ..RequestStats::default()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn latencies_are_each_attempts_own_wire_time_and_a_phase_starts_from_zero() {
    let script = (1..=20).map(|n| (n * 10, response(200, "{}"))).collect();
    let (sink, diagnostics) = recorder();
    let http = diagnostics.observe(&client(
        TimedTransport::new(script),
        RecordingSleeper::new(),
    ));

    diagnostics
        .phase(DiagnosticPhase::Bodies, async {
            for _ in 0..20 {
                http.send(ApiRequest::get("/sync/crdt/updates/x"))
                    .await
                    .unwrap();
            }
        })
        .await;

    let bodies = only_final(&sink, DiagnosticPhase::Bodies);
    assert_eq!(
        (bodies.requests, bodies.p50_ms, bodies.p95_ms, bodies.max_ms),
        (20, 100, 190, 200)
    );

    // The next phase counts only its own request, and a phase that sends
    // nothing reports nothing.
    let next = TimedTransport::new(vec![(5, response(200, "{}"))]);
    let http = diagnostics.observe(&client(next, RecordingSleeper::new()));
    diagnostics
        .phase(DiagnosticPhase::BodyPacks, async {
            http.send(ApiRequest::get("/sync/packs")).await.unwrap()
        })
        .await;
    diagnostics
        .phase(DiagnosticPhase::Reconcile, async {})
        .await;
    let packs = only_final(&sink, DiagnosticPhase::BodyPacks);
    assert_eq!(
        (packs.requests, packs.p50_ms, packs.max_ms),
        (1, 5, 5),
        "the earlier phase's latencies are gone"
    );
    assert!(!sink.events().iter().any(|event| matches!(
        event,
        CoreDiagnostic::PhaseStats {
            phase: DiagnosticPhase::Reconcile,
            ..
        }
    )));
}

#[tokio::test(start_paused = true)]
async fn a_long_phase_reports_a_snapshot_every_two_minutes_not_one_per_request() {
    // One request a minute for nine minutes.
    let script = (0..9).map(|_| (60_000, response(200, "{}"))).collect();
    let (sink, diagnostics) = recorder();
    let http = diagnostics.observe(&client(
        TimedTransport::new(script),
        RecordingSleeper::new(),
    ));

    diagnostics
        .phase(DiagnosticPhase::Bodies, async {
            for _ in 0..9 {
                http.send(ApiRequest::get("/sync/crdt/updates/x"))
                    .await
                    .unwrap();
            }
        })
        .await;

    let phases: Vec<(bool, u32)> = sink
        .events()
        .into_iter()
        .map(|event| match event {
            CoreDiagnostic::PhaseStats {
                finished, requests, ..
            } => (finished, requests.requests),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    // Snapshots after the 2nd, 4th, 6th and 8th minute, then the final one.
    assert_eq!(
        phases,
        vec![(false, 2), (false, 4), (false, 6), (false, 8), (true, 9)]
    );
    assert_eq!(INTERIM_INTERVAL, Duration::from_secs(120));
}

#[tokio::test(start_paused = true)]
async fn without_a_sink_nothing_is_counted_and_nothing_breaks() {
    let transport = FakeTransport::new(vec![response(200, "{}")]);
    let silent = RunDiagnostics::silent();
    let http = silent.observe(&client(transport, RecordingSleeper::new()));

    let status = silent
        .phase(DiagnosticPhase::Refs, async {
            http.send(ApiRequest::get("/sync/changes"))
                .await
                .unwrap()
                .status
        })
        .await;

    assert_eq!(status, 200);
}

type Answers = Vec<Result<HttpResponse, TransportError>>;

fn granted() -> Result<HttpResponse, TransportError> {
    response(
        200,
        r#"{"session":{"token":"boot-token","expiresAt":4000000000},"tailCursor":10}"#,
    )
}

#[tokio::test(start_paused = true)]
async fn the_bootstrap_open_reports_how_the_server_answered_as_a_closed_outcome() {
    let cases: Vec<(&str, Answers, (BootstrapOutcome, u16))> = vec![
        ("granted", vec![granted()], (BootstrapOutcome::Granted, 200)),
        (
            "no token",
            vec![response(200, r#"{"tailCursor":10}"#)],
            (BootstrapOutcome::NoToken, 200),
        ),
        (
            "not eligible",
            vec![error_response(
                409,
                "BOOTSTRAP_NOT_ELIGIBLE",
                "this device already pulled the vault",
            )],
            (BootstrapOutcome::NotEligible, 409),
        ),
        (
            "session limit",
            vec![error_response(
                429,
                "BOOTSTRAP_SESSION_LIMIT",
                "too many sessions",
            )],
            (BootstrapOutcome::SessionLimit, 429),
        ),
        (
            "an ordinary rate limit is not the session cap",
            vec![error_response(429, "RATE_LIMITED", "slow down")],
            (BootstrapOutcome::Failed, 429),
        ),
        (
            "no bootstrap key",
            vec![error_response(
                501,
                "BOOTSTRAP_UNAVAILABLE",
                "not configured",
            )],
            (BootstrapOutcome::NotImplemented, 501),
        ),
        (
            "a failing server",
            // The ladder's first attempt and its three retries.
            (0..4)
                .map(|_| error_response(503, "INTERNAL_ERROR", "down"))
                .collect(),
            (BootstrapOutcome::Failed, 503),
        ),
        (
            "no answer at all",
            (0..4).map(|_| Err(TransportError::Offline)).collect(),
            (BootstrapOutcome::Failed, 0),
        ),
    ];
    for (label, script, (outcome, status)) in cases {
        let (sink, diagnostics) = recorder();
        let http = client(FakeTransport::new(script), RecordingSleeper::new());
        let bootstrap = BootstrapClient::new(http).with_diagnostics(diagnostics);

        bootstrap.open(1_000).await;

        assert_eq!(
            sink.events(),
            vec![CoreDiagnostic::BootstrapOpened { outcome, status }],
            "{label}"
        );
    }
}
