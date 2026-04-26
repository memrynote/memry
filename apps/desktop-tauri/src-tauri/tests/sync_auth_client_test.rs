//! Tests for `sync::http` (narrow JSON HTTP client) and the auth/devices/
//! linking route wrappers in `sync::auth_client`.
//!
//! Goals enforced by these tests:
//!
//! - `post_json` / `get_json` send Content-Type: application/json and the
//!   `Authorization: Bearer <token>` header when supplied.
//! - HTTP 429 maps to `AppError::RateLimited(retry_after)`, parsing the
//!   `Retry-After` header when present.
//! - Any other non-2xx maps to `AppError::Network` whose message contains
//!   only the status code, never the response body bytes.
//! - `SYNC_SERVER_URL` is resolved per call, not at module init time. A
//!   debug build defaults to `http://localhost:8787` when the env var
//!   is unset.
//! - `auth_client` wrappers route to the canonical paths from the M4
//!   plan (auth, devices, linking, refresh).
//!
//! Tests that mutate `SYNC_SERVER_URL` acquire the `ENV_LOCK` static so
//! they cannot race across the cargo test thread pool. Tests that work
//! against `*_with_base` variants are parallel-safe and skip the lock.

use std::sync::Mutex;

use httpmock::prelude::*;
use serde_json::{json, Value};

use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::sync::auth_client;
use memry_desktop_tauri_lib::sync::http::{
    delete_json_with_base, get_json, get_json_with_base, post_json, post_json_with_base,
    resolve_base_url,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    key: &'static str,
    prev: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let prev = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, prev }
    }

    fn unset(key: &'static str) -> Self {
        let prev = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

#[tokio::test]
async fn post_json_sends_json_body_to_path() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/otp/request")
                .header("content-type", "application/json")
                .json_body(json!({ "email": "kaan@example.com" }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({ "success": true }));
        })
        .await;

    let body = json!({ "email": "kaan@example.com" });
    let resp: Value = post_json_with_base(&server.base_url(), "/auth/otp/request", &body, None)
        .await
        .expect("post_json_with_base must succeed");

    mock.assert_async().await;
    assert_eq!(resp["success"], json!(true));
}

#[tokio::test]
async fn post_json_attaches_bearer_token_when_provided() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/refresh")
                .header("authorization", "Bearer refresh-token-abc");
            then.status(200).json_body(json!({ "ok": true }));
        })
        .await;

    let _: Value = post_json_with_base(
        &server.base_url(),
        "/auth/refresh",
        &json!({}),
        Some("refresh-token-abc"),
    )
    .await
    .expect("authenticated post must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn post_json_omits_authorization_header_when_token_none() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request").matches(|req| {
                !req.headers
                    .as_ref()
                    .map(|h| {
                        h.iter()
                            .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                    })
                    .unwrap_or(false)
            });
            then.status(200).json_body(json!({ "ok": true }));
        })
        .await;

    let _: Value = post_json_with_base(&server.base_url(), "/auth/otp/request", &json!({}), None)
        .await
        .expect("anonymous post must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn post_json_429_maps_to_rate_limited_with_retry_after() {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(429)
                .header("retry-after", "42")
                .body("rate limited");
        })
        .await;

    let result: Result<Value, _> =
        post_json_with_base(&server.base_url(), "/auth/otp/request", &json!({}), None).await;

    match result {
        Err(AppError::RateLimited(Some(secs))) => assert_eq!(secs, 42),
        other => panic!("expected RateLimited(Some(42)), got {other:?}"),
    }
}

#[tokio::test]
async fn post_json_429_without_retry_after_returns_rate_limited_none() {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(429).body("");
        })
        .await;

    let result: Result<Value, _> =
        post_json_with_base(&server.base_url(), "/auth/otp/request", &json!({}), None).await;

    assert!(
        matches!(result, Err(AppError::RateLimited(None))),
        "missing retry-after must yield RateLimited(None), got {result:?}",
    );
}

#[tokio::test]
async fn post_json_500_maps_to_network_error_with_redacted_body() {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(500)
                .header("content-type", "application/json")
                .body(r#"{"error":"super-secret-leak-token-do-not-log"}"#);
        })
        .await;

    let result: Result<Value, _> =
        post_json_with_base(&server.base_url(), "/auth/otp/request", &json!({}), None).await;

    let err = result.expect_err("non-2xx must error");
    let msg = format!("{err}");
    assert!(
        matches!(err, AppError::Network(_)),
        "expected Network, got {err:?}"
    );
    assert!(
        !msg.contains("super-secret-leak-token-do-not-log"),
        "Network error message must not echo response body; got {msg}",
    );
    assert!(
        msg.contains("500"),
        "Network error should include the status code for debugging; got {msg}",
    );
}

#[tokio::test]
async fn post_json_400_maps_to_network_error_with_redacted_body() {
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(400)
                .body("validation failed: secret payload here");
        })
        .await;

    let result: Result<Value, _> =
        post_json_with_base(&server.base_url(), "/auth/otp/request", &json!({}), None).await;

    let err = result.expect_err("4xx (non-429) must error");
    let msg = format!("{err}");
    assert!(matches!(err, AppError::Network(_)));
    assert!(
        !msg.contains("secret payload here"),
        "client errors must not leak body; got {msg}",
    );
}

#[tokio::test]
async fn get_json_round_trips_typed_response() {
    #[derive(serde::Deserialize, Debug, PartialEq)]
    struct Devices {
        ok: bool,
    }

    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method(GET).path("/devices");
            then.status(200).json_body(json!({ "ok": true }));
        })
        .await;

    let devices: Devices = get_json_with_base(&server.base_url(), "/devices", None)
        .await
        .expect("get_json must succeed");
    assert_eq!(devices, Devices { ok: true });
}

#[tokio::test]
async fn get_json_attaches_bearer_token_when_provided() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/devices")
                .header("authorization", "Bearer access-token-xyz");
            then.status(200).json_body(json!({ "ok": true }));
        })
        .await;

    let _: Value = get_json_with_base(&server.base_url(), "/devices", Some("access-token-xyz"))
        .await
        .expect("authenticated get must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn delete_json_sends_delete_method() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(DELETE)
                .path("/devices/device-abc")
                .header("authorization", "Bearer access-token-xyz");
            then.status(200).json_body(json!({ "removed": true }));
        })
        .await;

    let _: Value = delete_json_with_base(
        &server.base_url(),
        "/devices/device-abc",
        Some("access-token-xyz"),
    )
    .await
    .expect("delete must succeed");

    mock.assert_async().await;
}

#[test]
fn resolve_base_url_uses_environment_when_set() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _env = EnvGuard::set("SYNC_SERVER_URL", "https://staging.example.com");
    assert_eq!(
        resolve_base_url().expect("env var must resolve"),
        "https://staging.example.com",
    );
}

#[test]
fn resolve_base_url_returns_debug_default_when_unset() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _env = EnvGuard::unset("SYNC_SERVER_URL");
    assert_eq!(
        resolve_base_url().expect("debug build must default"),
        "http://localhost:8787",
        "debug builds must default to localhost when SYNC_SERVER_URL is unset",
    );
}

#[test]
fn resolve_base_url_treats_empty_env_var_as_unset() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _env = EnvGuard::set("SYNC_SERVER_URL", "");
    assert_eq!(
        resolve_base_url().expect("empty value must fall through to default"),
        "http://localhost:8787",
    );
}

#[tokio::test]
async fn post_json_resolves_sync_server_url_per_call_not_at_module_load() {
    let _guard = ENV_LOCK.lock().unwrap();

    let server_a = MockServer::start_async().await;
    let mock_a = server_a
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(200).json_body(json!({ "tag": "a" }));
        })
        .await;

    let server_b = MockServer::start_async().await;
    let mock_b = server_b
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(200).json_body(json!({ "tag": "b" }));
        })
        .await;

    {
        let _env = EnvGuard::set("SYNC_SERVER_URL", &server_a.base_url());
        let resp: Value = post_json("/auth/otp/request", &json!({}), None)
            .await
            .expect("first call must hit server A");
        assert_eq!(resp["tag"], json!("a"));
    }

    {
        let _env = EnvGuard::set("SYNC_SERVER_URL", &server_b.base_url());
        let resp: Value = post_json("/auth/otp/request", &json!({}), None)
            .await
            .expect("second call must hit server B");
        assert_eq!(resp["tag"], json!("b"));
    }

    mock_a.assert_async().await;
    mock_b.assert_async().await;
}

#[tokio::test]
async fn get_json_uses_resolved_base_url_per_call() {
    let _guard = ENV_LOCK.lock().unwrap();

    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/devices");
            then.status(200).json_body(json!({ "ok": true }));
        })
        .await;

    let _env = EnvGuard::set("SYNC_SERVER_URL", &server.base_url());
    let _: Value = get_json("/devices", None)
        .await
        .expect("get_json must resolve URL via env per call");

    mock.assert_async().await;
}

#[tokio::test]
async fn auth_client_request_otp_posts_to_canonical_path() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path("/auth/otp/request");
            then.status(200).json_body(json!({ "success": true }));
        })
        .await;

    let body = json!({ "email": "kaan@example.com" });
    let _: Value = auth_client::request_otp_with_base(&server.base_url(), &body)
        .await
        .expect("request_otp wrapper must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn auth_client_refresh_token_posts_to_canonical_path_with_body_token() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/refresh")
                .json_body(json!({ "refreshToken": "refresh-token" }))
                .matches(|req| {
                    !req.headers
                        .as_ref()
                        .map(|h| {
                            h.iter()
                                .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                        })
                        .unwrap_or(false)
                });
            then.status(200).json_body(json!({ "access": "new" }));
        })
        .await;

    let _: Value = auth_client::refresh_token_with_base(
        &server.base_url(),
        &json!({ "refreshToken": "refresh-token" }),
    )
    .await
    .expect("refresh wrapper must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn auth_client_get_devices_uses_devices_path() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/devices")
                .header("authorization", "Bearer access-token");
            then.status(200).json_body(json!({ "items": [] }));
        })
        .await;

    let _: Value = auth_client::get_devices_with_base(&server.base_url(), "access-token")
        .await
        .expect("get_devices wrapper must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn auth_client_remove_device_sends_delete_to_devices_path() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(DELETE)
                .path("/devices/device-abc")
                .header("authorization", "Bearer access-token");
            then.status(200).json_body(json!({ "removed": true }));
        })
        .await;

    let _: Value =
        auth_client::remove_device_with_base(&server.base_url(), "device-abc", "access-token")
            .await
            .expect("remove_device wrapper must succeed");

    mock.assert_async().await;
}

#[tokio::test]
async fn auth_client_initiate_linking_posts_to_canonical_path() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/auth/linking/initiate")
                .header("authorization", "Bearer access-token");
            then.status(200).json_body(json!({ "sessionId": "sid-1" }));
        })
        .await;

    let body = json!({ "ephemeralPublicKey": "abc" });
    let _: Value =
        auth_client::initiate_linking_with_base(&server.base_url(), &body, "access-token")
            .await
            .expect("initiate_linking wrapper must succeed");

    mock.assert_async().await;
}
