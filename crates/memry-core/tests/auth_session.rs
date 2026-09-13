//! The authentication tier, T098: chapter 02 over a scripted `Transport`, and
//! data-model §C.1 edge for edge, failure edges included.

mod http_fakes;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use http_fakes::*;
use memry_core::api::auth::{
    AuthEvent, AuthProvider, AuthSession, AuthState, DeviceDescriptor, transition,
};
use memry_core::api::errors::AuthError;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::{
    DevicePlatform, REFRESH_REJECT_BACKOFF_MS, TokenClaims, TokenManager, device_challenge_message,
    fallback_retry_worthwhile, refresh_delay_ms, refresh_delay_ms_with,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
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
        // spec-defect 121: the restore edge.
        (
            AuthState::SignedOut,
            AuthEvent::SessionRestored,
            AuthState::Registered,
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
        // spec-defect 121: restore is drawn from `SignedOut` only. In
        // particular it does **not** resurrect a revoked or an expired
        // session, which are the two states a restore that collapsed them
        // would quietly overwrite.
        (AuthState::Revoked, AuthEvent::SessionRestored),
        (AuthState::SessionExpired, AuthEvent::SessionRestored),
        (AuthState::SetupPending, AuthEvent::SessionRestored),
        (AuthState::Refreshing, AuthEvent::SessionRestored),
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

// ---------------------------------------------------------------------------
// Native provider sign-in, chapter 02 §2.13 (T163)
// ---------------------------------------------------------------------------

/// Walks `SignedOut -> AwaitingProviderToken -> SetupPending` over a scripted
/// native-OAuth answer.
async fn provider_signed_in(
    answer: Result<
        memry_core::seams::transport::HttpResponse,
        memry_core::api::errors::TransportError,
    >,
) -> (
    AuthSession,
    Arc<FakeTransport>,
    Arc<FakeSecureStore>,
    Result<memry_core::api::auth::ProviderSignInOutcome, AuthError>,
) {
    let transport = FakeTransport::new(vec![answer]);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .begin_provider_sign_in(AuthProvider::Google)
        .unwrap();
    let outcome = session
        .complete_provider_sign_in("google-id-token".to_string())
        .await;
    (session, transport, store, outcome)
}

fn native_oauth_ok(jti: &str, is_new_user: bool, needs_setup: bool) -> String {
    format!(
        r#"{{"success":true,"isNewUser":{is_new_user},"needsSetup":{needs_setup},"setupToken":"{}"}}"#,
        setup_token(jti)
    )
}

#[tokio::test]
async fn a_provider_sheet_opens_the_awaiting_state_and_makes_no_request() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport.clone(), FakeSecureStore::new());

    let state = session
        .begin_provider_sign_in(AuthProvider::Google)
        .unwrap();

    // The provider slug is the core's, never the caller's: it is a path
    // segment of `/auth/oauth/:provider/native`.
    assert_eq!(
        state,
        AuthState::AwaitingProviderToken {
            provider: "google".to_string()
        }
    );
    // §2.13's shell half — the web authentication session — happens after this
    // call, so this one talks to nobody.
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn completing_a_provider_sign_in_posts_the_three_core_private_fields() {
    let (session, transport, store, outcome) =
        provider_signed_in(response(200, &native_oauth_ok("jti-oauth", true, true))).await;
    let outcome = outcome.expect("a provider sign-in");

    assert_eq!(outcome.state, AuthState::SetupPending);
    assert_eq!(session.state(), AuthState::SetupPending);
    // §2.13: `needsSetup` is "this account has no kdf_salt yet", which is the
    // difference between creating a recovery phrase and unlocking with one.
    assert!(outcome.is_new_user);
    assert!(outcome.needs_setup);

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert!(
        calls[0].url.ends_with("/auth/oauth/google/native"),
        "posted to {}",
        calls[0].url
    );

    let body = body_json(&calls[0]);
    assert_eq!(body["idToken"], "google-id-token");
    // The two fields the shell cannot supply. The public key is the tail of
    // the signing key the core holds in its own secure store, standard base64.
    let committed = body["devicePublicKey"].as_str().unwrap();
    let committed = BASE64_STANDARD.decode(committed).unwrap();
    let secret = store
        .get(SecureStoreKey::DeviceSigningKey)
        .unwrap()
        .expect("the core minted a signing key");
    assert_eq!(committed, secret[32..64]);
    assert!(!body["sessionNonce"].as_str().unwrap().is_empty());

    // §2.13: the setup token lands in the token manager, on the same path
    // `verify_email_code` uses — not in the caller's hands.
    assert_eq!(
        store.text(SecureStoreKey::SetupToken).as_deref(),
        Some(setup_token("jti-oauth").as_str())
    );
}

#[tokio::test]
async fn the_provider_nonce_is_the_one_registration_presents() {
    let transport = FakeTransport::new(vec![
        response(200, &native_oauth_ok("jti-oauth", false, false)),
        response(
            200,
            r#"{"success":true,"deviceId":"device-1","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
    ]);
    let session = session(transport.clone(), FakeSecureStore::new());
    session
        .begin_provider_sign_in(AuthProvider::Google)
        .unwrap();
    session
        .complete_provider_sign_in("google-id-token".to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap();

    let calls = transport.calls();
    // §2.6: one nonce per attempt, sent on the sign-in call **and** on
    // registration. A setup token that carries a nonce rejects a registration
    // that presents a different one, so the OAuth path mints it exactly where
    // the OTP path does.
    assert_eq!(
        body_json(&calls[0])["sessionNonce"],
        body_json(&calls[1])["sessionNonce"]
    );
    assert_eq!(session.state(), AuthState::Registered);
}

#[tokio::test]
async fn a_rejected_provider_token_takes_the_failure_edge_back_to_signed_out() {
    let (session, _transport, store, outcome) = provider_signed_in(error_response(
        401,
        "AUTH_INVALID_TOKEN",
        "id token rejected",
    ))
    .await;

    assert!(
        matches!(
            outcome,
            Err(AuthError::Api {
                source: memry_core::api::errors::ApiError::Unauthorized { .. }
            })
        ),
        "expected an unauthorized, got {outcome:?}"
    );
    // §C.1 draws one edge for cancelled, expired and rejected.
    assert_eq!(session.state(), AuthState::SignedOut);
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test]
async fn a_provider_answer_without_a_setup_token_is_not_a_sign_in() {
    let (session, _transport, store, outcome) = provider_signed_in(response(
        200,
        r#"{"success":true,"isNewUser":false,"needsSetup":false}"#,
    ))
    .await;

    assert!(
        matches!(outcome, Err(AuthError::NoSetupToken)),
        "expected NoSetupToken, got {outcome:?}"
    );
    assert_eq!(session.state(), AuthState::SignedOut);
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test]
async fn a_deployment_without_the_ios_client_id_is_refused_once_and_not_retried() {
    // §2.13: a 501 means `GOOGLE_IOS_CLIENT_ID` is unset. It is **not** a
    // fallback to the web OAuth client, and it cannot change within a
    // deployment — so a retry ladder spent on it is a ladder spent on nothing.
    let (session, transport, _store, outcome) =
        provider_signed_in(error_response(501, "NOT_CONFIGURED", "no ios client id")).await;

    match outcome {
        Err(AuthError::Api {
            source: memry_core::api::errors::ApiError::Status { status, .. },
        }) => assert_eq!(status, 501),
        other => panic!("expected a 501 status, got {other:?}"),
    }
    assert_eq!(transport.call_count(), 1, "the 501 was retried");
    assert_eq!(session.state(), AuthState::SignedOut);
}

#[tokio::test]
async fn a_provider_token_cannot_be_spent_without_a_sheet() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport.clone(), FakeSecureStore::new());

    let error = session
        .complete_provider_sign_in("google-id-token".to_string())
        .await
        .expect_err("a sign-in from SignedOut");

    // The **action** is asserted, not just the state: the only other refusal
    // this method can produce reports a different one. Asserting the state
    // alone let the state guard be deleted with every test still green.
    assert!(
        matches!(
            error,
            AuthError::InvalidState { ref action, ref state }
                if action == "complete a provider sign-in" && state == "SignedOut"
        ),
        "expected InvalidState from the state guard, got {error:?}"
    );
    assert_eq!(transport.call_count(), 0);
}

// ---------------------------------------------------------------------------
// The account reads, chapter 02 §2.1.1 and chapter 05 §5.1 (T163)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn key_material_reads_the_salt_and_verifier_over_the_session() {
    let (session, transport, _store) = registered(vec![response(
        200,
        r#"{"kdfSalt":"c2FsdHNhbHRzYWx0c2FsdA==","keyVerifier":"dmVyaWZpZXI="}"#,
    )])
    .await;

    let material = session.key_material().await.expect("key material");
    // Chapter 01 §1.1 and §1.4.1: both cross as the base64 strings the
    // comparison is defined over, never as decoded bytes.
    assert_eq!(material.kdf_salt, "c2FsdHNhbHRzYWx0c2FsdA==");
    assert_eq!(material.key_verifier, "dmVyaWZpZXI=");

    let call = transport.calls().pop().unwrap();
    assert!(call.url.ends_with("/auth/key-verifier"), "{}", call.url);
    assert_eq!(call.method, "GET");
    // §2.7.1: the account is known because the session says so.
    assert_eq!(
        call.headers.get("authorization").map(String::as_str),
        Some("Bearer access-1")
    );
}

#[tokio::test]
async fn half_a_key_material_is_a_malformed_response_and_not_a_default() {
    let (session, _transport, _store) =
        registered(vec![response(200, r#"{"kdfSalt":"c2FsdA=="}"#)]).await;

    match session.key_material().await {
        Err(memry_core::api::errors::ApiError::MalformedResponse { path, .. }) => {
            assert_eq!(path, "/auth/key-verifier");
        }
        other => panic!("expected a malformed response, got {other:?}"),
    }
}

#[tokio::test]
async fn the_vault_registry_crosses_with_its_rows_intact() {
    let (session, transport, _store) = registered(vec![response(
        200,
        r#"{"vaults":[{"vaultUuid":"v1","name":"Work"},{"vaultUuid":"v2"}]}"#,
    )])
    .await;

    let vaults = session.vaults().await.expect("a registry");
    assert_eq!(vaults.len(), 2);
    assert_eq!(vaults[0].id, "v1");
    assert_eq!(vaults[0].name.as_deref(), Some("Work"));
    assert_eq!(vaults[1].id, "v2");
    assert_eq!(vaults[1].name, None);

    let call = transport.calls().pop().unwrap();
    assert!(call.url.ends_with("/sync/vaults"), "{}", call.url);
}

#[tokio::test]
async fn an_unreadable_vault_row_is_never_reported_as_an_empty_account() {
    // The incident this rule exists for: a reader that filtered the row out
    // told an account holding four vaults that it held none.
    let (session, _transport, _store) = registered(vec![response(
        200,
        r#"{"vaults":[{"vaultUuid":"v1"},{"name":"nameless"}]}"#,
    )])
    .await;

    match session.vaults().await {
        Err(memry_core::api::errors::ApiError::MalformedResponse { path, .. }) => {
            assert_eq!(path, "/sync/vaults");
        }
        other => panic!("expected a malformed response, got {other:?}"),
    }
}

#[tokio::test]
async fn an_empty_registry_means_empty() {
    let (session, _transport, _store) = registered(vec![response(200, r#"{"vaults":[]}"#)]).await;
    assert_eq!(session.vaults().await.expect("a registry").len(), 0);
}

// ---------------------------------------------------------------------------
// Cold-launch restore, spec-defect 121
// ---------------------------------------------------------------------------

/// The defect itself, end to end: sign in, throw the session away as a process
/// exit would, build a second one over the **same** secure store, and reopen.
///
/// The second session is built by `session()` — the same constructor the shell
/// calls — so nothing here is a special "restored" object. Before `restore()`
/// existed this test's second assertion read `SignedOut`, which is the bug: a
/// working refresh token on disk and a sign-in screen in front of it.
#[tokio::test]
async fn a_relaunch_over_the_same_store_reopens_the_session() {
    let (first, _transport, store) = registered(vec![]).await;
    assert_eq!(first.state(), AuthState::Registered);
    drop(first);

    let next = session(FakeTransport::new(vec![]), store.clone());
    // The process just started. This is what every launch saw before.
    assert_eq!(next.state(), AuthState::SignedOut);

    assert_eq!(next.restore().unwrap(), AuthState::Registered);
    assert_eq!(next.state(), AuthState::Registered);
}

/// The restored session spends the **stored** refresh token rather than a
/// remembered one: a restore that produced the right state over a token it
/// could not use would pass every assertion above and fail on the first call.
#[tokio::test]
async fn a_restored_session_refreshes_with_the_token_from_the_store() {
    let (first, _transport, store) = registered(vec![]).await;
    drop(first);

    let transport = FakeTransport::new(vec![response(
        200,
        r#"{"accessToken":"access-2","refreshToken":"refresh-2","expiresIn":900}"#,
    )]);
    let next = session(transport.clone(), store.clone());
    next.restore().unwrap();

    assert_eq!(next.refresh().await.unwrap(), AuthState::Registered);
    let sent = transport.calls_to("/auth/refresh");
    assert_eq!(sent.len(), 1);
    assert_eq!(body_json(&sent[0])["refreshToken"], "refresh-1");
    assert_eq!(
        store.text(SecureStoreKey::RefreshToken).as_deref(),
        Some("refresh-2")
    );
}

/// No token is `SignedOut`, and nothing is asked of the network to find that
/// out. A restore that probed the server would be a launch that can suspend
/// for an hour and cannot be cancelled (spec-defects 108 and 109).
#[tokio::test]
async fn a_first_launch_stays_signed_out_and_makes_no_request() {
    let transport = FakeTransport::new(vec![]);
    let fresh = session(transport.clone(), FakeSecureStore::new());

    assert_eq!(fresh.restore().unwrap(), AuthState::SignedOut);
    assert_eq!(fresh.state(), AuthState::SignedOut);
    assert_eq!(transport.call_count(), 0);
}

/// data-model §B's distinction, at the one place it decides what a user sees.
///
/// A locked keychain is neither "signed out" nor "signed in": the two arms
/// return **different shapes**, not two spellings of the same state, so a
/// caller cannot confuse them and the state is left where a later call can try
/// again. The `Ok`/`Err` pair is asserted together on purpose — the previous
/// phase lost a bug to two branches that returned the same value.
#[tokio::test]
async fn a_locked_store_is_neither_signed_out_nor_restored() {
    let (first, _transport, store) = registered(vec![]).await;
    drop(first);
    store.lock_device();

    let next = session(FakeTransport::new(vec![]), store.clone());
    let error = next.restore().unwrap_err();
    assert!(
        matches!(error, AuthError::SecureStore { .. }),
        "a locked store must not read as an absent token: {error:?}"
    );
    // Unchanged, so the retry below is a retry and not a second first attempt.
    assert_eq!(next.state(), AuthState::SignedOut);

    store.unlock_device();
    assert_eq!(next.restore().unwrap(), AuthState::Registered);
}

/// `SignedOut`, `SessionExpired` and `Revoked` stay three different states
/// across a relaunch, which is the whole reason the edge lands in `Registered`
/// rather than in a state of its own: both of the other two are edges **out
/// of** `Registered`, so before the restore existed a relaunched app could
/// reach neither.
#[tokio::test]
async fn the_three_signed_out_shaped_states_stay_distinct_after_a_restore() {
    // Expired: one refusal is enough — §2.10's first 401 already moves the
    // machine. Reached only because the restore put it somewhere that has a
    // `RefreshRefused` edge; from `SignedOut` there is no such edge and
    // `refresh` is `InvalidState`.
    let (first, _t, store) = registered(vec![]).await;
    drop(first);
    let expired = session(
        FakeTransport::new(vec![error_response(401, "AUTH_INVALID_TOKEN", "no")]),
        store.clone(),
    );
    expired.restore().unwrap();
    let _ = expired.refresh().await.unwrap_err();
    assert_eq!(expired.state(), AuthState::SessionExpired);

    // Revoked: terminal, and it clears the store, so the next launch of the
    // same app is genuinely signed out rather than restored into a session
    // that no longer exists.
    let (second, _t2, store2) = registered(vec![]).await;
    drop(second);
    let revoked = session(FakeTransport::new(vec![]), store2.clone());
    revoked.restore().unwrap();
    assert_eq!(revoked.mark_revoked().unwrap(), AuthState::Revoked);
    drop(revoked);

    let after = session(FakeTransport::new(vec![]), store2);
    assert_eq!(after.restore().unwrap(), AuthState::SignedOut);
}

/// Called twice, or from a state that is not `SignedOut`, it reports what it
/// found and changes nothing. A launch signal that arrives twice must not be
/// an error the shell learns to suppress.
#[tokio::test]
async fn restoring_twice_is_not_a_second_sign_in() {
    let (first, _transport, store) = registered(vec![]).await;
    drop(first);

    let next = session(FakeTransport::new(vec![]), store);
    assert_eq!(next.restore().unwrap(), AuthState::Registered);
    assert_eq!(next.restore().unwrap(), AuthState::Registered);

    // And from a state that is emphatically not a restorable one.
    let (live, _t, _s) = registered(vec![]).await;
    assert_eq!(live.mark_revoked().unwrap(), AuthState::Revoked);
    assert_eq!(live.restore().unwrap(), AuthState::Revoked);
}
