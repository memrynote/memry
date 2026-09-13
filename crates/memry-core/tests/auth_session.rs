//! The authentication tier, T098: chapter 02 over a scripted `Transport`, and
//! data-model §C.1 edge for edge, failure edges included.

mod http_fakes;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use http_fakes::*;
use memry_core::api::auth::{AuthEvent, AuthSession, AuthState, DeviceDescriptor, transition};
use memry_core::api::errors::AuthError;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::{
    DevicePlatform, REFRESH_REJECT_BACKOFF_MS, TokenClaims, TokenManager, device_challenge_message,
    fallback_retry_worthwhile, refresh_delay_ms, refresh_delay_ms_with,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::seams::secure_store::SecureStoreKey;
use serde_json::json;

const BASE: &str = "https://sync.example.com";

fn descriptor() -> DeviceDescriptor {
    DeviceDescriptor {
        name: "Kaan's iPhone".to_string(),
        // Chapter 02 §2.12: the registration enum, while `x-memry-client`
        // carries `ios` from `CLIENT_PLATFORMS`. They coincide for a phone.
        platform: DevicePlatform::Ios,
        os_version: Some("26.0".to_string()),
        app_version: "1.4.2".to_string(),
        vault_id: None,
    }
}

fn session(transport: Arc<FakeTransport>, store: Arc<FakeSecureStore>) -> AuthSession {
    AuthSession::new(
        transport,
        store,
        BASE.to_string(),
        "ios".to_string(),
        descriptor(),
    )
    .unwrap()
}

fn setup_token(jti: &str) -> String {
    jwt(json!({ "sub": "user-1", "jti": jti, "exp": 4_102_444_800u64, "type": "setup" }))
}

fn sign_in_script(
    jti: &str,
) -> Vec<Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError>>
{
    vec![
        response(200, r#"{"success":true,"expiresIn":600}"#),
        response(
            200,
            &format!(r#"{{"success":true,"setupToken":"{}"}}"#, setup_token(jti)),
        ),
        response(
            200,
            r#"{"success":true,"deviceId":"device-1","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
    ]
}

/// Walks `SignedOut -> AwaitingOtp -> SetupPending -> Registered`.
async fn registered(
    extra: Vec<
        Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError>,
    >,
) -> (AuthSession, Arc<FakeTransport>, Arc<FakeSecureStore>) {
    let mut script = sign_in_script("jti-1");
    script.extend(extra);
    let transport = FakeTransport::new(script);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();
    session
        .verify_email_code("123456".to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap();
    assert_eq!(session.state(), AuthState::Registered);
    (session, transport, store)
}

// ---------------------------------------------------------------------------
// The machine, data-model §C.1
// ---------------------------------------------------------------------------

#[test]
fn every_drawn_edge_exists() {
    let awaiting = AuthState::AwaitingOtp {
        email: "kaan@example.com".to_string(),
    };
    let provider = AuthState::AwaitingProviderToken {
        provider: "apple".to_string(),
    };
    let edges = vec![
        (
            AuthState::SignedOut,
            AuthEvent::OtpRequested {
                email: "kaan@example.com".to_string(),
            },
            awaiting.clone(),
        ),
        (
            AuthState::SignedOut,
            AuthEvent::ProviderSheetOpened {
                provider: "apple".to_string(),
            },
            provider.clone(),
        ),
        (
            awaiting.clone(),
            AuthEvent::SetupTokenIssued,
            AuthState::SetupPending,
        ),
        (
            awaiting.clone(),
            AuthEvent::SignInFailed,
            AuthState::SignedOut,
        ),
        (
            provider.clone(),
            AuthEvent::SetupTokenIssued,
            AuthState::SetupPending,
        ),
        (provider, AuthEvent::SignInFailed, AuthState::SignedOut),
        (
            AuthState::SetupPending,
            AuthEvent::DeviceRegistered,
            AuthState::Registered,
        ),
        (
            AuthState::SetupPending,
            AuthEvent::SetupTokenExpired,
            AuthState::SetupExpired,
        ),
        (
            AuthState::SetupExpired,
            AuthEvent::SetupTokenRenewed,
            AuthState::SetupPending,
        ),
        (
            AuthState::SetupExpired,
            AuthEvent::SetupNotRenewable,
            AuthState::SignedOut,
        ),
        (
            AuthState::Registered,
            AuthEvent::RefreshStarted,
            AuthState::Refreshing,
        ),
        (
            AuthState::Registered,
            AuthEvent::RefreshRefused,
            AuthState::SessionExpired,
        ),
        (
            AuthState::Registered,
            AuthEvent::DeviceRevoked,
            AuthState::Revoked,
        ),
        (
            AuthState::Registered,
            AuthEvent::SignedOutByUser,
            AuthState::SignedOut,
        ),
        (
            AuthState::Refreshing,
            AuthEvent::RefreshSucceeded,
            AuthState::Registered,
        ),
        (
            AuthState::Refreshing,
            AuthEvent::RefreshRefused,
            AuthState::SessionExpired,
        ),
        (
            AuthState::SessionExpired,
            AuthEvent::RefreshSucceeded,
            AuthState::Registered,
        ),
        (
            AuthState::SessionExpired,
            AuthEvent::SignedOutByUser,
            AuthState::SignedOut,
        ),
        (
            AuthState::Revoked,
            AuthEvent::SignedOutByUser,
            AuthState::SignedOut,
        ),
    ];
    for (from, event, expected) in edges {
        assert_eq!(
            transition(&from, &event),
            Some(expected),
            "missing edge {from:?} + {event:?}"
        );
    }
}

#[test]
fn nothing_the_chapter_does_not_draw_is_an_edge() {
    let undrawn = vec![
        // No sign-in shortcut past device registration.
        (
            AuthState::AwaitingOtp {
                email: "k@e.com".to_string(),
            },
            AuthEvent::DeviceRegistered,
        ),
        // A setup token cannot be renewed before it expires.
        (AuthState::SetupPending, AuthEvent::SetupTokenRenewed),
        // Refresh is not reachable from a session that has no device yet.
        (AuthState::SetupPending, AuthEvent::RefreshStarted),
        // `Revoked` is terminal until the user acts: nothing but a sign-out
        // leaves it, and in particular a later refresh does not.
        (AuthState::Revoked, AuthEvent::RefreshSucceeded),
        (AuthState::Revoked, AuthEvent::RefreshStarted),
        // A second `Refreshing` cannot start while one is running.
        (AuthState::Refreshing, AuthEvent::RefreshStarted),
        // Revocation is drawn from `Registered` only.
        (AuthState::SessionExpired, AuthEvent::DeviceRevoked),
        (AuthState::SignedOut, AuthEvent::SetupTokenIssued),
    ];
    for (from, event) in undrawn {
        assert_eq!(
            transition(&from, &event),
            None,
            "unexpected edge {from:?} + {event:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// Sign-in, chapter 02 §2.3 and §2.6
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sign_in_registers_a_device_and_stores_the_pair() {
    let (_session, transport, store) = registered(vec![]).await;
    let calls = transport.calls();
    assert_eq!(calls.len(), 3);

    let verify = body_json(&calls[1]);
    // §2.5: committing the key is what makes a renewal possible at all.
    let committed = verify["devicePublicKey"].as_str().unwrap();
    assert!(BASE64_STANDARD.decode(committed).unwrap().len() == 32);

    let register = body_json(&calls[2]);
    // §2.6: the same value on the sign-in call and on registration. A client
    // that sends it on one and omits it on the other is rejected.
    assert_eq!(verify["sessionNonce"], register["sessionNonce"]);
    assert!(!register["sessionNonce"].as_str().unwrap().is_empty());
    assert_eq!(register["platform"], "ios");
    assert_eq!(register["appVersion"], "1.4.2");
    assert_eq!(register["osVersion"], "26.0");
    // Omitted rather than null: the server's schema rejects an explicit null.
    assert!(register.get("vaultId").is_none());
    // Registration is authorised by the setup token, not by a session token.
    assert_eq!(
        calls[2].headers.get("authorization").unwrap(),
        &format!("Bearer {}", setup_token("jti-1"))
    );

    // §2.3.1: Ed25519 detached over `nonce:jti`, standard base64, no prefix.
    let public = BASE64_STANDARD
        .decode(register["authPublicKey"].as_str().unwrap())
        .unwrap();
    let signature = BASE64_STANDARD
        .decode(register["challengeSignature"].as_str().unwrap())
        .unwrap();
    let message = device_challenge_message(register["challengeNonce"].as_str().unwrap(), "jti-1");
    assert!(sodium::sign_verify_detached(&signature, &message, &public));
    assert_eq!(
        message,
        format!("{}:jti-1", register["challengeNonce"].as_str().unwrap()).into_bytes()
    );

    assert_eq!(
        store.text(SecureStoreKey::AccessToken).as_deref(),
        Some("access-1")
    );
    assert_eq!(
        store.text(SecureStoreKey::RefreshToken).as_deref(),
        Some("refresh-1")
    );
    // §2.3.3: the setup token is single-use, so a spent one is not kept.
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test]
async fn a_verify_with_no_setup_token_falls_back_to_signed_out() {
    let transport = FakeTransport::new(vec![
        response(200, r#"{"success":true}"#),
        response(200, r#"{"success":false}"#),
    ]);
    let session = session(transport, FakeSecureStore::new());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();

    let error = session
        .verify_email_code("000000".to_string())
        .await
        .unwrap_err();

    assert!(matches!(error, AuthError::NoSetupToken));
    assert_eq!(session.state(), AuthState::SignedOut);
}

#[tokio::test]
async fn a_rejected_code_returns_to_signed_out() {
    let transport = FakeTransport::new(vec![
        response(200, r#"{"success":true}"#),
        error_response(401, "AUTH_INVALID_OTP", "wrong code"),
    ]);
    let session = session(transport, FakeSecureStore::new());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();

    session
        .verify_email_code("000000".to_string())
        .await
        .unwrap_err();

    assert_eq!(session.state(), AuthState::SignedOut);
}

#[tokio::test]
async fn verifying_before_a_code_was_requested_is_refused() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport.clone(), FakeSecureStore::new());

    let error = session
        .verify_email_code("123456".to_string())
        .await
        .unwrap_err();

    assert!(matches!(error, AuthError::InvalidState { .. }));
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn a_spent_setup_token_expires_and_renewal_recovers_it() {
    let renewed = jwt(json!({ "sub": "user-1", "jti": "jti-2", "exp": 4_102_444_800u64 }));
    let transport = FakeTransport::new(vec![
        response(200, r#"{"success":true}"#),
        response(
            200,
            &format!(
                r#"{{"success":true,"setupToken":"{}"}}"#,
                setup_token("jti-1")
            ),
        ),
        // §2.3.3: a spent or aged-out setup token is 401 AUTH_INVALID_TOKEN.
        error_response(401, "AUTH_INVALID_TOKEN", "Setup token already used"),
        response(
            200,
            &format!(r#"{{"success":true,"setupToken":"{renewed}"}}"#),
        ),
        response(
            200,
            r#"{"success":true,"deviceId":"d","accessToken":"a","refreshToken":"r"}"#,
        ),
    ]);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();
    session
        .verify_email_code("123456".to_string())
        .await
        .unwrap();

    session.register_device().await.unwrap_err();
    assert_eq!(session.state(), AuthState::SetupExpired);

    assert_eq!(
        session.renew_setup_token().await.unwrap(),
        AuthState::SetupPending
    );
    // §2.5: renewal is not a bearer operation — it is authorised by the
    // signature over the committed key.
    let renew_call = &transport.calls()[3];
    assert!(!renew_call.headers.contains_key("authorization"));
    let renew_body = body_json(renew_call);
    assert_eq!(renew_body["setupToken"], setup_token("jti-1"));

    // The renewed grant carries a new jti, so the next challenge signs that
    // one rather than reusing the retired one.
    session.register_device().await.unwrap();
    let register = body_json(&transport.calls()[4]);
    let public = BASE64_STANDARD
        .decode(register["authPublicKey"].as_str().unwrap())
        .unwrap();
    let signature = BASE64_STANDARD
        .decode(register["challengeSignature"].as_str().unwrap())
        .unwrap();
    let message = device_challenge_message(register["challengeNonce"].as_str().unwrap(), "jti-2");
    assert!(sodium::sign_verify_detached(&signature, &message, &public));
    assert_eq!(session.state(), AuthState::Registered);
}

#[tokio::test]
async fn a_renewal_that_fails_signs_out() {
    let transport = FakeTransport::new(vec![
        response(200, r#"{"success":true}"#),
        response(
            200,
            &format!(
                r#"{{"success":true,"setupToken":"{}"}}"#,
                setup_token("jti-1")
            ),
        ),
        error_response(401, "AUTH_INVALID_TOKEN", "spent"),
        error_response(401, "AUTH_INVALID_TOKEN", "chain spent"),
    ]);
    let session = session(transport, FakeSecureStore::new());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();
    session
        .verify_email_code("123456".to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap_err();

    session.renew_setup_token().await.unwrap_err();

    assert_eq!(session.state(), AuthState::SignedOut);
}

// ---------------------------------------------------------------------------
// Token lifecycle, chapter 02 §2.9 and §2.10
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_refresh_replaces_the_pair_and_returns_to_registered() {
    let (session, transport, store) = registered(vec![response(
        200,
        r#"{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":900}"#,
    )])
    .await;

    assert_eq!(session.refresh().await.unwrap(), AuthState::Registered);

    let refresh_call = transport.calls_to("/auth/refresh");
    assert_eq!(refresh_call.len(), 1);
    assert_eq!(body_json(&refresh_call[0])["refreshToken"], "refresh-1");
    assert_eq!(
        store.text(SecureStoreKey::AccessToken).as_deref(),
        Some("access-2")
    );
    assert_eq!(
        store.text(SecureStoreKey::RefreshToken).as_deref(),
        Some("refresh-2")
    );
}

#[tokio::test(start_paused = true)]
async fn three_401s_latch_refresh_permanently() {
    let (session, transport, _store) = registered(vec![
        error_response(401, "AUTH_INVALID_TOKEN", "no"),
        error_response(401, "AUTH_INVALID_TOKEN", "no"),
        error_response(401, "AUTH_INVALID_TOKEN", "no"),
    ])
    .await;
    let before = transport.call_count();

    // First 401: never retried inline (§2.9 — a naive retry revokes every
    // token this device holds), and the first window is 60 s.
    let error = session.refresh().await.unwrap_err();
    assert_eq!(
        error,
        AuthError::RefreshBlocked {
            retry_in_ms: REFRESH_REJECT_BACKOFF_MS[0]
        }
    );
    assert_eq!(session.state(), AuthState::SessionExpired);
    assert_eq!(transport.call_count(), before + 1);

    // Inside the window the client does not touch the network at all.
    let error = session.refresh().await.unwrap_err();
    assert!(matches!(error, AuthError::RefreshBlocked { .. }));
    assert_eq!(transport.call_count(), before + 1);

    tokio::time::sleep(Duration::from_secs(61)).await;
    let error = session.refresh().await.unwrap_err();
    assert_eq!(
        error,
        AuthError::RefreshBlocked {
            retry_in_ms: REFRESH_REJECT_BACKOFF_MS[1]
        }
    );
    assert_eq!(transport.call_count(), before + 2);

    tokio::time::sleep(Duration::from_secs(301)).await;
    assert_eq!(
        session.refresh().await.unwrap_err(),
        AuthError::SessionExpired
    );
    assert_eq!(transport.call_count(), before + 3);

    // Permanent: the user must sign in again, and no further request is made.
    assert_eq!(
        session.refresh().await.unwrap_err(),
        AuthError::SessionExpired
    );
    assert_eq!(transport.call_count(), before + 3);
}

#[tokio::test(start_paused = true)]
async fn a_non_401_refresh_failure_walks_its_own_ladder() {
    let (_session, transport, store) = registered(vec![]).await;
    let refresh_transport = FakeTransport::new(vec![
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
        error_response(500, "INTERNAL_ERROR", "boom"),
    ]);
    let _ = transport;
    let http = Arc::new(HttpClient::new(
        refresh_transport.clone(),
        BASE,
        ClientIdentity::new("ios", "1.4.2").unwrap(),
    ));
    let tokens = TokenManager::new(store, http);

    let error = tokens.refresh(None).await.unwrap_err();

    // §2.10: `REFRESH_MAX_RETRIES` of them on a non-401, and no latch.
    assert_eq!(refresh_transport.call_count(), 4);
    assert!(matches!(error, AuthError::Api { .. }));
    assert_eq!(tokens.refresh_block_ms(), None);
}

#[tokio::test(start_paused = true)]
async fn concurrent_callers_share_one_refresh() {
    let (_session, _transport, store) = registered(vec![]).await;
    let refresh_transport = FakeTransport::slow(
        vec![response(
            200,
            r#"{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":900}"#,
        )],
        50,
    );
    let http = Arc::new(HttpClient::new(
        refresh_transport.clone(),
        BASE,
        ClientIdentity::new("ios", "1.4.2").unwrap(),
    ));
    let tokens = Arc::new(TokenManager::new(store, http));

    let a = tokens.clone();
    let b = tokens.clone();
    let (first, second) = tokio::join!(
        async move { a.refresh(Some("access-1")).await },
        async move { b.refresh(Some("access-1")).await }
    );

    // §2.10: a client that does not single-flight reproduces the storm — 58
    // requests in 47 minutes from one install.
    assert_eq!(refresh_transport.call_count(), 1);
    assert_eq!(first.unwrap(), "access-2");
    assert_eq!(second.unwrap(), "access-2");
}

#[tokio::test]
async fn signing_out_clears_every_entry() {
    let (session, _transport, store) = registered(vec![response(200, "{}")]).await;

    assert_eq!(session.sign_out().await.unwrap(), AuthState::SignedOut);

    assert_eq!(store.text(SecureStoreKey::AccessToken), None);
    assert_eq!(store.text(SecureStoreKey::RefreshToken), None);
    assert_eq!(store.text(SecureStoreKey::DeviceSigningKey), None);
}

#[tokio::test]
async fn revocation_clears_the_session_before_it_is_shown() {
    let (session, _transport, store) = registered(vec![]).await;

    assert_eq!(session.mark_revoked().unwrap(), AuthState::Revoked);

    assert_eq!(store.text(SecureStoreKey::AccessToken), None);
    // Terminal until the user acts.
    assert!(matches!(
        session.refresh().await.unwrap_err(),
        AuthError::InvalidState { .. }
    ));
}

#[tokio::test]
async fn a_locked_secure_store_is_not_an_absent_key() {
    // data-model §B: a retrieval failure is "locked", never "absent". Treating
    // it as absent would mint a second device identity over a working one.
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let session = session(transport, store.clone());
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();
    store.lock_device();

    let error = session
        .verify_email_code("123456".to_string())
        .await
        .unwrap_err();

    assert!(matches!(error, AuthError::SecureStore { .. }));
}

// ---------------------------------------------------------------------------
// The arithmetic, chapter 02 §2.10
// ---------------------------------------------------------------------------

#[test]
fn the_proactive_schedule_sits_between_half_and_seventy_percent() {
    assert_eq!(refresh_delay_ms_with(900, 0.0), 450_000);
    assert_eq!(refresh_delay_ms_with(900, 1.0), 630_000);
    for _ in 0..64 {
        let drawn = refresh_delay_ms(900);
        assert!((450_000..=630_000).contains(&drawn), "{drawn}");
    }
}

#[test]
fn a_token_inside_the_safety_margin_counts_as_expired() {
    let claims = TokenClaims::parse(&jwt(json!({ "exp": 1_000u64 }))).unwrap();
    assert!(claims.is_expired(941));
    assert!(!claims.is_expired(939));
    // §2.2 requires `exp`; its absence is not licence to trust the token.
    assert!(TokenClaims::parse(&jwt(json!({}))).unwrap().is_expired(0));
    assert!(fallback_retry_worthwhile(60));
    assert!(!fallback_retry_worthwhile(59));
}

#[test]
fn a_token_that_is_not_a_jwt_is_reported_rather_than_guessed() {
    assert!(matches!(
        TokenClaims::parse("not-a-jwt"),
        Err(AuthError::MalformedToken { .. })
    ));
    assert!(matches!(
        TokenClaims::parse("a.!!!.c"),
        Err(AuthError::MalformedToken { .. })
    ));
    assert!(
        TokenClaims::parse(&jwt(json!({ "sub": "u" })))
            .unwrap()
            .require_jti()
            .is_err()
    );
}
