//! #4156: what an authenticated call reports when its demand-driven refresh
//! fails. Only a 401 on refresh can end the session (chapter 02 §2.10), so a
//! refresh that never reached the server, or one the rejection latch is
//! holding back, must not come back as the call's own stale 401, which the
//! shells render as "no longer signed in".
//!
//! Wired the way `AuthSession::new` wires it: one `TokenManager` refreshing
//! over a provider-less client, behind the client every other call uses.

mod http_fakes;

use std::sync::Arc;

use http_fakes::*;
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::protocol::auth::{REFRESH_REJECT_BACKOFF_MS, TokenManager};
use memry_core::protocol::http::{ApiRequest, Auth, ClientIdentity, HttpClient};
use memry_core::seams::secure_store::SecureStoreKey;

const BASE: &str = "https://sync.example.com";

fn session_client(transport: Arc<FakeTransport>) -> HttpClient {
    let identity = ClientIdentity::new("ios", "1.4.2").unwrap();
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::AccessToken, "access-1");
    store.put_text(SecureStoreKey::RefreshToken, "refresh-1");
    let refresh_http = Arc::new(HttpClient::new(transport.clone(), BASE, identity.clone()));
    let tokens = Arc::new(TokenManager::new(store, refresh_http));
    HttpClient::new(transport, BASE, identity)
        .with_sleeper(RecordingSleeper::new())
        .with_tokens(tokens)
}

fn changes() -> ApiRequest {
    ApiRequest::get("/sync/changes").auth(Auth::Session)
}

#[tokio::test(start_paused = true)]
async fn an_offline_refresh_reports_offline_not_signed_out() {
    let transport = FakeTransport::new(vec![
        error_response(401, "AUTH_TOKEN_EXPIRED", "expired"),
        Err(TransportError::Offline),
        Err(TransportError::Offline),
        Err(TransportError::Offline),
        Err(TransportError::Offline),
    ]);
    let client = session_client(transport.clone());

    let error = client.send(changes()).await.unwrap_err();

    assert_eq!(
        error,
        ApiError::Transport {
            source: TransportError::Offline
        }
    );
    assert_eq!(transport.calls_to("/auth/refresh").len(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_refresh_held_by_the_rejection_latch_reports_the_wait_not_signed_out() {
    let transport = FakeTransport::new(vec![
        error_response(401, "AUTH_TOKEN_EXPIRED", "expired"),
        error_response(401, "AUTH_INVALID_TOKEN", "refresh refused"),
    ]);
    let client = session_client(transport.clone());

    let error = client.send(changes()).await.unwrap_err();

    assert_eq!(
        error,
        ApiError::RateLimited {
            retry_after_s: Some(REFRESH_REJECT_BACKOFF_MS[0] / 1_000),
            message: format!(
                "refresh is blocked for another {} ms",
                REFRESH_REJECT_BACKOFF_MS[0]
            ),
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_permanently_refused_refresh_still_reports_signed_out() {
    let transport = FakeTransport::new(vec![]);
    let client = session_client(transport.clone());
    let mut script = Vec::new();
    for _ in 0..3 {
        script.push(error_response(401, "AUTH_TOKEN_EXPIRED", "expired"));
        script.push(error_response(401, "AUTH_INVALID_TOKEN", "refresh refused"));
    }
    for item in script {
        transport.push(item);
    }

    for wait_ms in REFRESH_REJECT_BACKOFF_MS {
        let error = client.send(changes()).await.unwrap_err();
        assert!(matches!(error, ApiError::RateLimited { .. }), "{error:?}");
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms + 1_000)).await;
    }
    let error = client.send(changes()).await.unwrap_err();

    assert!(matches!(error, ApiError::Unauthorized { .. }), "{error:?}");
}
