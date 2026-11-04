//! `AuthSession::send_telemetry`: the route, the bearer, and what the shell is
//! told to do with the batch.
//!
//! | Test                                               | Rule                                    |
//! | -------------------------------------------------- | --------------------------------------- |
//! | a signed-out send posts the bytes with no bearer   | `routes/telemetry.ts` reports anonymous |
//! | a signed-in send carries the access token          | the server hashes the account           |
//! | a 400 is rejected, a 5xx and offline retry later   | an old server 400s the whole batch      |

mod http_fakes;

use std::sync::Arc;

use http_fakes::*;
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::TransportError;
use memry_core::api::telemetry::TelemetryDelivery;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::transport::HttpResponse;
use serde_json::json;

type Script = Vec<Result<HttpResponse, TransportError>>;

fn session(script: Script) -> (AuthSession, Arc<FakeTransport>) {
    let transport = FakeTransport::new(script);
    let device = DeviceDescriptor {
        name: "iPhone".to_string(),
        platform: DevicePlatform::Ios,
        os_version: None,
        app_version: "1.0.0".to_string(),
        vault_id: None,
    };
    let session = AuthSession::new(
        transport.clone(),
        FakeSecureStore::new(),
        "https://sync.example.com".to_string(),
        "ios".to_string(),
        device,
    )
    .unwrap();
    (session, transport)
}

const BATCH: &[u8] = br#"{"schemaVersion":1}"#;

#[tokio::test]
async fn a_signed_out_send_posts_the_bytes_with_no_bearer() {
    let (session, transport) = session(vec![response(202, r#"{"accepted":1}"#)]);

    let delivery = session.send_telemetry(BATCH.to_vec()).await;

    assert_eq!(delivery, TelemetryDelivery::Accepted);
    let call = transport.calls().pop().expect("a request");
    assert_eq!(call.method, "POST");
    assert_eq!(call.url, "https://sync.example.com/telemetry/batch");
    assert_eq!(call.body.as_deref(), Some(BATCH));
    assert!(!call.headers.contains_key("authorization"));
}

#[tokio::test]
async fn a_signed_in_send_carries_the_access_token() {
    let setup = jwt(json!({ "sub": "u", "jti": "jti-1", "exp": 4_102_444_800u64 }));
    let (session, transport) = session(vec![
        response(200, r#"{"success":true,"expiresIn":600}"#),
        response(
            200,
            &format!(r#"{{"success":true,"setupToken":"{setup}"}}"#),
        ),
        response(
            200,
            r#"{"success":true,"deviceId":"d","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
        response(202, r#"{"accepted":1}"#),
    ]);
    session
        .request_email_code("k@example.com".into())
        .await
        .unwrap();
    session.verify_email_code("123456".into()).await.unwrap();
    session.register_device().await.unwrap();

    session.send_telemetry(BATCH.to_vec()).await;

    let call = transport.calls().pop().expect("a request");
    assert_eq!(
        call.headers.get("authorization").map(String::as_str),
        Some("Bearer access-1")
    );
}

#[tokio::test]
async fn a_400_is_rejected_a_5xx_and_offline_retry_later() {
    let cases: [(Result<HttpResponse, TransportError>, TelemetryDelivery); 4] = [
        (
            error_response(400, "VALIDATION_ERROR", "Invalid telemetry payload"),
            TelemetryDelivery::Rejected,
        ),
        (
            error_response(503, "UNAVAILABLE", "down"),
            TelemetryDelivery::RetryLater,
        ),
        (
            error_response(429, "RATE_LIMITED", "slow down"),
            TelemetryDelivery::RetryLater,
        ),
        (Err(TransportError::Offline), TelemetryDelivery::RetryLater),
    ];
    for (answer, expected) in cases {
        let (session, transport) = session(vec![answer]);
        assert_eq!(session.send_telemetry(BATCH.to_vec()).await, expected);
        assert_eq!(transport.calls().len(), 1, "no retry inside the core");
    }
}
