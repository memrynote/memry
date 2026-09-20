//! The HTTP tier, T097: the retry ladder, the backoff, the token refresh, the
//! error-body parse, and the outcomes a caller must act on rather than retry.
//!
//! Every test drives a scripted `Transport`. The core opens no socket of its
//! own here or anywhere (Constitution I).

mod http_fakes;

use std::sync::Arc;
use std::sync::Mutex;

use http_fakes::*;
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::http::{
    ApiRequest, Auth, ClientIdentity, HttpClient, RetryPolicy, TokenProvider,
};

const BASE: &str = "https://sync.example.com";

fn identity() -> ClientIdentity {
    ClientIdentity::new("ios", "1.4.2").unwrap()
}

fn make_client(transport: Arc<FakeTransport>, sleeper: Arc<RecordingSleeper>) -> HttpClient {
    HttpClient::new(transport, BASE, identity()).with_sleeper(sleeper)
}

/// A provider that hands out one token and swaps it on refresh.
struct FakeTokens {
    current: Mutex<String>,
    refreshes: Mutex<usize>,
    refusal: Option<ApiError>,
}

impl FakeTokens {
    fn new(token: &str) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new(token.to_string()),
            refreshes: Mutex::new(0),
            refusal: None,
        })
    }

    fn refusing(token: &str) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new(token.to_string()),
            refreshes: Mutex::new(0),
            refusal: Some(ApiError::Unauthorized {
                code: "AUTH_INVALID_TOKEN".to_string(),
                message: "refresh refused".to_string(),
            }),
        })
    }

    fn refreshes(&self) -> usize {
        *self.refreshes.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl TokenProvider for FakeTokens {
    async fn access_token(&self) -> Option<String> {
        Some(self.current.lock().unwrap().clone())
    }

    async fn refresh(&self, _stale: &str) -> Result<String, ApiError> {
        *self.refreshes.lock().unwrap() += 1;
        if let Some(refusal) = &self.refusal {
            return Err(refusal.clone());
        }
        let mut current = self.current.lock().unwrap();
        *current = "fresh-access-token".to_string();
        Ok(current.clone())
    }
}

fn authorization(request: &memry_core::seams::transport::HttpRequest) -> Option<&String> {
    request.headers.get("authorization")
}

#[tokio::test]
async fn every_request_carries_the_chapter_00_and_11_headers() {
    let transport = FakeTransport::new(vec![response(200, "{}")]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    client.send(ApiRequest::get("/sync/status")).await.unwrap();

    let call = &transport.calls()[0];
    assert_eq!(call.url, "https://sync.example.com/sync/status");
    assert_eq!(
        call.headers.get("content-type").unwrap(),
        "application/json"
    );
    assert_eq!(call.headers.get("accept").unwrap(), "application/json");
    // FR-034, chapter 11 §11.1: lowercase, and on an unauthenticated call too.
    assert_eq!(call.headers.get("x-memry-client").unwrap(), "ios/1.4.2");
    assert_eq!(call.timeout_ms, 60_000);
    assert!(authorization(call).is_none());
}

#[tokio::test]
async fn a_500_walks_the_ladder_and_doubles_the_delay() {
    let transport = FakeTransport::new(vec![
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
    ]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    let error = client
        .send(ApiRequest::get("/sync/status"))
        .await
        .unwrap_err();

    // One attempt plus `maxRetries` of them.
    assert_eq!(transport.call_count(), 4);
    assert_eq!(sleeper.slept(), vec![2_000, 4_000, 8_000]);
    assert!(matches!(error, ApiError::Status { status: 500, .. }));
}

#[tokio::test]
async fn a_500_that_clears_returns_the_body() {
    let transport = FakeTransport::new(vec![
        error_response(503, "INTERNAL_ERROR", "cold start"),
        response(200, r#"{"ok":true}"#),
    ]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    let response = client.send(ApiRequest::get("/sync/status")).await.unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(sleeper.slept(), vec![2_000]);
}

#[tokio::test]
async fn push_does_not_resend_the_same_batch_on_a_5xx() {
    // Chapter 05 §5.6: an oversized push dies at the edge with an empty 503
    // body, so an identical resend fails identically. The caller halves.
    let transport = FakeTransport::new(vec![response(503, "")]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    let error = client
        .send(ApiRequest::post("/sync/push").retry(RetryPolicy::push()))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert!(sleeper.slept().is_empty());
    match error {
        ApiError::Status {
            status, message, ..
        } => {
            assert_eq!(status, 503);
            // A non-JSON body degrades to the status (chapter 00 §0.4).
            assert_eq!(message, "HTTP 503");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_429_waits_for_the_lowercase_retry_after() {
    let transport = FakeTransport::new(vec![
        response_with_header(
            429,
            r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
            ("retry-after", "7"),
        ),
        response(200, "{}"),
    ]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    client.send(ApiRequest::get("/sync/changes")).await.unwrap();

    assert_eq!(sleeper.slept(), vec![7_000]);
}

#[tokio::test]
async fn a_long_retry_after_comes_back_rather_than_being_slept_through() {
    // A rate limiter counting down a long window answers `Retry-After: 2358`.
    // Slept through, that is thirty-nine minutes of a sign-in screen showing
    // "Sending your code" with no error and no way out — which is what it did.
    // The wait past the ceiling is the caller's to make, and the error carries
    // the seconds so it can say how long.
    let transport = FakeTransport::new(vec![
        response_with_header(
            429,
            r#"{"error":{"code":"RATE_LIMITED","message":"Too many requests"}}"#,
            ("retry-after", "2358"),
        ),
        response(200, "{}"),
    ]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    let error = client
        .send(ApiRequest::get("/sync/changes"))
        .await
        .unwrap_err();

    assert!(sleeper.slept().is_empty(), "nothing may sleep that long");
    assert_eq!(transport.call_count(), 1);
    match error {
        ApiError::RateLimited { retry_after_s, .. } => {
            assert_eq!(
                retry_after_s,
                Some(2358),
                "the caller needs the wait in order to state it"
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_polled_call_does_not_retry_a_429() {
    // Chapter 07 §7.10 and chapter 03 §3.9: the poll cadence is the retry.
    let transport = FakeTransport::new(vec![error_response(429, "RATE_LIMITED", "slow down")]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    let error = client
        .send(ApiRequest::post("/sync/crdt/pull").retry(RetryPolicy::polled()))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert!(matches!(
        error,
        ApiError::RateLimited {
            retry_after_s: None,
            ..
        }
    ));
}

#[tokio::test]
async fn a_transport_failure_is_retried_but_a_tls_failure_is_not() {
    let transport = FakeTransport::new(vec![
        Err(TransportError::Offline),
        Err(TransportError::Timeout { elapsed_ms: 60_000 }),
        response(200, "{}"),
    ]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());
    client.send(ApiRequest::get("/health")).await.unwrap();
    assert_eq!(sleeper.slept(), vec![2_000, 4_000]);

    let tls = FakeTransport::new(vec![Err(TransportError::Tls {
        what: "bad certificate".to_string(),
    })]);
    let client = make_client(tls.clone(), RecordingSleeper::new());
    let error = client.send(ApiRequest::get("/health")).await.unwrap_err();
    assert_eq!(tls.call_count(), 1);
    assert!(matches!(
        error,
        ApiError::Transport {
            source: TransportError::Tls { .. }
        }
    ));
}

#[tokio::test]
async fn a_cancel_never_counts_against_the_budget() {
    let transport = FakeTransport::new(vec![Err(TransportError::Cancelled)]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    let error = client.send(ApiRequest::get("/health")).await.unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert!(matches!(
        error,
        ApiError::Transport {
            source: TransportError::Cancelled
        }
    ));
}

#[tokio::test]
async fn a_401_refreshes_once_and_replays_with_the_new_token() {
    let transport = FakeTransport::new(vec![
        error_response(401, "AUTH_TOKEN_EXPIRED", "expired"),
        response(200, r#"{"items":[]}"#),
    ]);
    let tokens = FakeTokens::new("stale-access-token");
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone()).with_tokens(tokens.clone());

    let response = client
        .send(ApiRequest::get("/sync/changes").auth(Auth::Session))
        .await
        .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(tokens.refreshes(), 1);
    let calls = transport.calls();
    assert_eq!(
        authorization(&calls[0]).unwrap(),
        "Bearer stale-access-token"
    );
    assert_eq!(
        authorization(&calls[1]).unwrap(),
        "Bearer fresh-access-token"
    );
    // A refresh is not a retry: it costs no backoff.
    assert!(sleeper.slept().is_empty());
}

#[tokio::test]
async fn a_second_401_after_a_refresh_is_not_refreshed_again() {
    let transport = FakeTransport::new(vec![
        error_response(401, "AUTH_TOKEN_EXPIRED", "expired"),
        error_response(401, "AUTH_INVALID_TOKEN", "still no"),
    ]);
    let tokens = FakeTokens::new("stale-access-token");
    let client =
        make_client(transport.clone(), RecordingSleeper::new()).with_tokens(tokens.clone());

    let error = client
        .send(ApiRequest::get("/sync/changes").auth(Auth::Session))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 2);
    assert_eq!(tokens.refreshes(), 1);
    assert!(matches!(error, ApiError::Unauthorized { .. }));
}

#[tokio::test]
async fn a_refused_refresh_surfaces_the_calls_own_401() {
    let transport = FakeTransport::new(vec![error_response(401, "AUTH_TOKEN_EXPIRED", "expired")]);
    let tokens = FakeTokens::refusing("stale-access-token");
    let client =
        make_client(transport.clone(), RecordingSleeper::new()).with_tokens(tokens.clone());

    let error = client
        .send(ApiRequest::get("/sync/changes").auth(Auth::Session))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert_eq!(tokens.refreshes(), 1);
    match error {
        ApiError::Unauthorized { code, .. } => assert_eq!(code, "AUTH_TOKEN_EXPIRED"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_bearer_call_is_never_refreshed() {
    // A setup token is not the session's, so a 401 on `POST /auth/devices`
    // must not drag the session's refresh path in (chapter 02 §2.3.3).
    let transport = FakeTransport::new(vec![error_response(401, "AUTH_INVALID_TOKEN", "spent")]);
    let tokens = FakeTokens::new("access");
    let client =
        make_client(transport.clone(), RecordingSleeper::new()).with_tokens(tokens.clone());

    let error = client
        .send(ApiRequest::post("/auth/devices").auth(Auth::Bearer("setup".to_string())))
        .await
        .unwrap_err();

    assert_eq!(tokens.refreshes(), 0);
    assert_eq!(
        authorization(&transport.calls()[0]).unwrap(),
        "Bearer setup"
    );
    assert!(matches!(error, ApiError::Unauthorized { .. }));
}

#[tokio::test]
async fn a_501_from_bootstrap_is_its_own_outcome_and_is_never_retried() {
    // Chapter 10 §10.12: the deployment has no bootstrap key. Not a 5xx to
    // retry, and not a client bug to report.
    let transport = FakeTransport::new(vec![error_response(
        501,
        "BOOTSTRAP_UNAVAILABLE",
        "Bootstrap sessions are not configured",
    )]);
    let sleeper = RecordingSleeper::new();
    let client = make_client(transport.clone(), sleeper.clone());

    let error = client
        .send(ApiRequest::post("/sync/bootstrap/session"))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert!(sleeper.slept().is_empty());
    assert_eq!(error, ApiError::BootstrapUnavailable);
}

#[tokio::test]
async fn other_501s_stay_generic_and_are_still_not_retried() {
    let transport = FakeTransport::new(vec![error_response(
        501,
        "STORAGE_PRESIGN_UNAVAILABLE",
        "no presign",
    )]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    let error = client
        .send(ApiRequest::get("/sync/blob/x"))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    match error {
        ApiError::Status { status, code, .. } => {
            assert_eq!(status, 501);
            assert_eq!(code.as_deref(), Some("STORAGE_PRESIGN_UNAVAILABLE"));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_two_client_policy_codes_are_their_own_outcomes() {
    let transport = FakeTransport::new(vec![response(
        426,
        r#"{"error":{"code":"CLIENT_UPGRADE_REQUIRED","message":"update","minVersion":"2.1.0"}}"#,
    )]);
    let client = make_client(transport.clone(), RecordingSleeper::new());
    let error = client
        .send(ApiRequest::post("/sync/push"))
        .await
        .unwrap_err();
    match error {
        // Chapter 11 §11.6: `minVersion` rides inside the error object.
        ApiError::UpgradeRequired { min_version, .. } => {
            assert_eq!(min_version.as_deref(), Some("2.1.0"))
        }
        other => panic!("{other:?}"),
    }

    let transport = FakeTransport::new(vec![error_response(
        403,
        "PLATFORM_WRITES_DISABLED",
        "writes off",
    )]);
    let client = make_client(transport.clone(), RecordingSleeper::new());
    let error = client
        .send(ApiRequest::post("/sync/push"))
        .await
        .unwrap_err();
    assert!(matches!(error, ApiError::WritesDisabled { .. }));
    assert_eq!(transport.call_count(), 1);
}

#[tokio::test]
async fn a_revoked_device_is_terminal_on_any_status() {
    let transport = FakeTransport::new(vec![error_response(409, "AUTH_DEVICE_REVOKED", "gone")]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    let error = client
        .send(ApiRequest::post("/sync/push"))
        .await
        .unwrap_err();

    assert_eq!(transport.call_count(), 1);
    assert!(matches!(error, ApiError::DeviceRevoked { .. }));
}

#[tokio::test]
async fn an_unknown_code_is_an_error_with_a_status_not_a_parse_failure() {
    // Chapter 00 §0.5.1: the enum is the server's and a later server may start
    // using a code this build has never heard of.
    let transport = FakeTransport::new(vec![error_response(
        400,
        "SOMETHING_INVENTED_LATER",
        "new code",
    )]);
    let client = make_client(transport.clone(), RecordingSleeper::new());

    let error = client
        .send(ApiRequest::get("/sync/status"))
        .await
        .unwrap_err();

    match error {
        ApiError::Status {
            status,
            code,
            message,
        } => {
            assert_eq!(status, 400);
            assert_eq!(code.as_deref(), Some("SOMETHING_INVENTED_LATER"));
            assert_eq!(message, "new code");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_bare_string_error_shape_is_tolerated() {
    let transport = FakeTransport::new(vec![response(400, r#"{"error":"Invalid cursor"}"#)]);
    let client = make_client(transport, RecordingSleeper::new());

    let error = client
        .send(ApiRequest::get("/sync/changes"))
        .await
        .unwrap_err();

    match error {
        ApiError::Status { code, message, .. } => {
            assert_eq!(code, None);
            assert_eq!(message, "Invalid cursor");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_2xx_that_does_not_parse_is_reported_rather_than_defaulted() {
    let transport = FakeTransport::new(vec![response(200, "not json at all")]);
    let client = make_client(transport, RecordingSleeper::new());

    let error = client
        .send_json::<serde_json::Value>(ApiRequest::get("/sync/status"))
        .await
        .unwrap_err();

    assert!(matches!(error, ApiError::MalformedResponse { .. }));
}
