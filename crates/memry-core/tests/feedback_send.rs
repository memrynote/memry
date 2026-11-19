//! `AuthSession::send_feedback`: the route, the bearer, and the refusals the
//! shell shows.
//!
//! | Test                                               | Rule                                      |
//! | -------------------------------------------------- | ----------------------------------------- |
//! | a signed-out send posts the bytes with no bearer   | `routes/feedback.ts` takes anonymous mail |
//! | a signed-in send carries the access token          | the server resolves account and plan      |
//! | a refusal reaches the caller once, unretried       | a retry would email twice                 |

mod http_fakes;

use std::sync::Arc;

use http_fakes::*;
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::transport::HttpResponse;
use serde_json::json;

type Script = Vec<Result<HttpResponse, TransportError>>;

fn session(script: Script) -> (AuthSession, Arc<FakeTransport>) {
    let transport = FakeTransport::new(script);
    let device = DeviceDescriptor {
        name: "iPhone".to_string(),
        platform: DevicePlatform::Ios,
        form_factor: None,
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

const PAYLOAD: &[u8] = br#"{"message":"first sync never ends","platform":"iOS"}"#;

#[tokio::test]
async fn a_signed_out_send_posts_the_bytes_with_no_bearer() {
    let (session, transport) = session(vec![response(202, r#"{"success":true}"#)]);

    session.send_feedback(PAYLOAD.to_vec()).await.unwrap();

    let call = transport.calls().pop().expect("a request");
    assert_eq!(call.method, "POST");
    assert_eq!(call.url, "https://sync.example.com/feedback");
    assert_eq!(call.body.as_deref(), Some(PAYLOAD));
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
        response(202, r#"{"success":true}"#),
    ]);
    session
        .request_email_code("k@example.com".into())
        .await
        .unwrap();
    session.verify_email_code("123456".into()).await.unwrap();
    session.register_device().await.unwrap();

    session.send_feedback(PAYLOAD.to_vec()).await.unwrap();

    let call = transport.calls().pop().expect("a request");
    assert_eq!(
        call.headers.get("authorization").map(String::as_str),
        Some("Bearer access-1")
    );
}

#[tokio::test]
async fn a_refusal_reaches_the_caller_once_unretried() {
    let answers: [Result<HttpResponse, TransportError>; 3] = [
        error_response(429, "RATE_LIMITED", "Too many requests"),
        error_response(503, "UNAVAILABLE", "down"),
        Err(TransportError::Offline),
    ];
    for answer in answers {
        let (session, transport) = session(vec![answer]);
        let error = session.send_feedback(PAYLOAD.to_vec()).await.unwrap_err();
        assert!(
            matches!(
                error,
                ApiError::Status { .. } | ApiError::RateLimited { .. } | ApiError::Transport { .. }
            ),
            "unexpected {error:?}"
        );
        assert_eq!(transport.calls().len(), 1, "no retry inside the core");
    }
}
