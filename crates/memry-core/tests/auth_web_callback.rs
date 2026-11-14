//! The browser-code OAuth callback (chapter 02, `POST /auth/oauth/:provider/callback`) and
//! `GET /auth/recovery-info` (§2.7), over a scripted `Transport`.
//!
//! Electron is the reference: the callback body is the one
//! `apps/desktop/src/main/ipc/auth-oauth-handlers.ts:239-246` posts, plus the §2.6 nonce; the
//! callback is single-use and tied to the `state` its attempt opened, as
//! `consumeOAuthSession` (`ipc/auth-oauth-state.ts:27-38`) makes it; and `recovery_info` reads
//! the body `RecoveryDataResponseSchema` (`packages/contracts/src/auth-api.ts:140`) accepts.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use http_fakes::*;
use memry_core::api::auth::{AuthProvider, AuthSession, AuthState, DeviceDescriptor};
use memry_core::api::errors::TransportError;
use memry_core::api::errors::{ApiError, AuthError, SecureStoreError};
use memry_core::protocol::account::KeyMaterial;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{HttpResponse, Transport};
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const STATE: &str = "state-jwt-1";
const REDIRECT: &str = "http://127.0.0.1:51234/callback";

type Answer = Result<HttpResponse, TransportError>;

fn session(transport: Arc<FakeTransport>, store: Arc<dyn SecureStore>) -> AuthSession {
    AuthSession::new(
        transport as Arc<dyn Transport>,
        store,
        BASE.to_string(),
        "desktop".to_string(),
        DeviceDescriptor {
            name: "Kaan's Mac".to_string(),
            platform: DevicePlatform::Macos,
            form_factor: None,
            os_version: None,
            app_version: "1.0.0".to_string(),
            vault_id: None,
        },
    )
    .unwrap()
}

fn setup_token(jti: &str) -> String {
    jwt(json!({ "sub": "user-1", "jti": jti, "exp": 4_102_444_800u64, "type": "setup" }))
}

/// The answer `apps/sync-server/src/routes/auth.ts:397-403` writes.
fn callback_ok(jti: &str, known_device: bool) -> Answer {
    response(
        200,
        &json!({
            "success": true,
            "isNewUser": false,
            "needsSetup": false,
            "knownDevice": known_device,
            "setupToken": setup_token(jti),
        })
        .to_string(),
    )
}

fn opened(script: Vec<Answer>) -> (AuthSession, Arc<FakeTransport>, Arc<FakeSecureStore>) {
    let transport = FakeTransport::new(script);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            STATE.to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();
    (session, transport, store)
}

fn awaiting() -> AuthState {
    AuthState::AwaitingProviderToken {
        provider: "google".to_string(),
    }
}

#[tokio::test]
async fn opening_a_web_sign_in_makes_no_request() {
    let (session, transport, _) = opened(vec![]);
    assert_eq!(session.state(), awaiting());
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn the_callback_posts_electrons_body_and_lands_in_setup_pending() {
    let (session, transport, store) = opened(vec![callback_ok("jti-web", true)]);

    let outcome = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .expect("a web sign-in");
    assert_eq!(outcome.state, AuthState::SetupPending);
    assert_eq!(session.state(), AuthState::SetupPending);
    assert!(!outcome.needs_setup);
    assert!(!outcome.is_new_user);
    // `knownDevice` decides whether the phrase is asked for
    // (`auth-oauth-handlers.ts:265`), so it crosses.
    assert!(outcome.known_device);

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].url, format!("{BASE}/auth/oauth/google/callback"));
    // Unauthenticated, as Electron's `postToServer` call is: the code is the credential.
    assert_eq!(calls[0].headers.get("authorization"), None);

    let body = body_json(&calls[0]);
    let mut keys: Vec<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "code",
            "devicePublicKey",
            "redirectUri",
            "sessionNonce",
            "state"
        ]
    );
    assert_eq!(body["code"], "auth-code");
    assert_eq!(body["state"], STATE);
    // The redirect the attempt was opened with, never one the callback supplies.
    assert_eq!(body["redirectUri"], REDIRECT);
    let committed = BASE64_STANDARD
        .decode(body["devicePublicKey"].as_str().unwrap())
        .unwrap();
    let secret = store
        .get(SecureStoreKey::DeviceSigningKey)
        .unwrap()
        .expect("the core minted a signing key");
    assert_eq!(committed, secret[32..64]);
    assert!(!body["sessionNonce"].as_str().unwrap().is_empty());

    assert_eq!(
        store.text(SecureStoreKey::SetupToken).as_deref(),
        Some(setup_token("jti-web").as_str())
    );
}

#[tokio::test]
async fn a_server_without_known_device_reads_as_unknown() {
    let (session, _, _) = opened(vec![response(
        200,
        &json!({ "success": true, "setupToken": setup_token("jti-old") }).to_string(),
    )]);
    let outcome = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .unwrap();
    // Chapter 02: servers before `knownDevice` omit it, which a client MUST read as false.
    assert!(!outcome.known_device);
    assert!(!outcome.needs_setup);
}

#[tokio::test]
async fn a_callback_for_another_state_is_refused_and_the_attempt_survives() {
    let (session, transport, store) = opened(vec![callback_ok("jti-web", false)]);

    let forged = session
        .complete_provider_web_callback("evil-code".to_string(), "forged-state".to_string())
        .await;
    assert!(
        matches!(forged, Err(AuthError::InvalidState { .. })),
        "{forged:?}"
    );
    // Refused before the network, and the real attempt is untouched: a forged
    // callback does not get to cancel the user's sign-in
    // (`consumeOAuthSession` throws without deleting the real session).
    assert_eq!(transport.call_count(), 0);
    assert_eq!(session.state(), awaiting());
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);

    session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .expect("the real callback still completes");
    assert_eq!(body_json(&transport.calls()[0])["code"], "auth-code");
}

#[tokio::test]
async fn a_replayed_callback_after_success_is_refused() {
    let (session, transport, _) = opened(vec![callback_ok("jti-web", false)]);
    session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .unwrap();

    let replay = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(
        matches!(replay, Err(AuthError::InvalidState { .. })),
        "{replay:?}"
    );
    assert_eq!(transport.call_count(), 1);
    assert_eq!(session.state(), AuthState::SetupPending);
}

#[tokio::test]
async fn a_replayed_callback_after_a_refusal_is_refused() {
    let (session, transport, store) = opened(vec![error_response(
        401,
        "AUTH_INVALID_TOKEN",
        "Invalid OAuth state",
    )]);
    let first = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(matches!(first, Err(AuthError::Api { .. })), "{first:?}");
    // The same failure edge the native call takes.
    assert_eq!(session.state(), AuthState::SignedOut);
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);

    let replay = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(
        matches!(replay, Err(AuthError::InvalidState { .. })),
        "{replay:?}"
    );
    assert_eq!(transport.call_count(), 1);
}

#[tokio::test]
async fn a_replayed_state_is_spent_once_a_new_attempt_opens() {
    let (session, transport, _) = opened(vec![error_response(
        401,
        "AUTH_INVALID_TOKEN",
        "Invalid OAuth state",
    )]);
    let _ = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            "state-jwt-2".to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();
    let calls_before = transport.call_count();

    let replay = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(
        matches!(replay, Err(AuthError::InvalidState { .. })),
        "{replay:?}"
    );
    assert_eq!(transport.call_count(), calls_before);
    assert_eq!(session.state(), awaiting());
}

// The paused clock orders the sleeps, so the interleaving does not depend on the runner.
#[tokio::test(start_paused = true)]
async fn two_deliveries_of_one_callback_post_once() {
    let transport = FakeTransport::slow(vec![callback_ok("jti-web", false)], 50);
    let session = session(transport.clone(), FakeSecureStore::new());
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            STATE.to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();

    let (a, b) = tokio::join!(
        session.complete_provider_web_callback("auth-code".to_string(), STATE.to_string()),
        session.complete_provider_web_callback("auth-code".to_string(), STATE.to_string()),
    );
    assert_eq!(transport.call_count(), 1);
    assert_eq!(
        [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "{a:?} {b:?}"
    );
    assert_eq!(session.state(), AuthState::SetupPending);
}

#[tokio::test]
async fn a_native_attempt_takes_no_browser_callback() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport.clone(), FakeSecureStore::new());
    session
        .begin_provider_sign_in(AuthProvider::Google)
        .unwrap();

    let result = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(
        matches!(result, Err(AuthError::InvalidState { .. })),
        "{result:?}"
    );
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn an_abandoned_web_attempt_takes_no_late_callback() {
    let (session, transport, _) = opened(vec![]);
    session.abandon_provider_sign_in().unwrap();
    // A native sheet opened afterwards is a different attempt.
    session
        .begin_provider_sign_in(AuthProvider::Google)
        .unwrap();

    let late = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(
        matches!(late, Err(AuthError::InvalidState { .. })),
        "{late:?}"
    );
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn a_second_web_sign_in_while_one_is_open_is_refused() {
    let (session, _, _) = opened(vec![]);
    let second = session.begin_provider_web_sign_in(
        AuthProvider::Google,
        "state-jwt-2".to_string(),
        REDIRECT.to_string(),
    );
    assert!(
        matches!(second, Err(AuthError::InvalidState { .. })),
        "{second:?}"
    );
}

#[tokio::test]
async fn the_callback_nonce_is_the_one_registration_presents() {
    let (session, transport, _) = opened(vec![
        callback_ok("jti-web", false),
        response(
            200,
            r#"{"success":true,"deviceId":"device-1","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
    ]);
    session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap();

    let calls = transport.calls();
    assert_eq!(
        body_json(&calls[0])["sessionNonce"],
        body_json(&calls[1])["sessionNonce"]
    );
    assert_eq!(session.state(), AuthState::Registered);
}

#[tokio::test]
async fn a_callback_answer_with_no_setup_token_signs_out() {
    let (session, _, _) = opened(vec![response(200, r#"{"success":true}"#)]);
    let result = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(matches!(result, Err(AuthError::NoSetupToken)), "{result:?}");
    assert_eq!(session.state(), AuthState::SignedOut);
}

// ---------------------------------------------------------------------------
// GET /auth/recovery-info, chapter 02 §2.7
// ---------------------------------------------------------------------------

fn holding_setup_token(script: Vec<Answer>) -> (AuthSession, Arc<FakeTransport>) {
    let transport = FakeTransport::new(script);
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::SetupToken, &setup_token("jti-setup"));
    (session(transport.clone(), store), transport)
}

#[tokio::test]
async fn recovery_info_reads_electrons_shape_with_the_setup_token() {
    // The body `RecoveryDataResponseSchema` parses in `device-registration.ts:294`.
    let (session, transport) = holding_setup_token(vec![response(
        200,
        r#"{"kdfSalt":"c2FsdHNhbHRzYWx0c2FsdA==","keyVerifier":"dmVyaWZpZXI="}"#,
    )]);

    let material = session.recovery_info().await.expect("recovery info");
    assert_eq!(
        material,
        KeyMaterial {
            kdf_salt: "c2FsdHNhbHRzYWx0c2FsdA==".to_string(),
            key_verifier: "dmVyaWZpZXI=".to_string(),
        }
    );

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "GET");
    assert_eq!(calls[0].url, format!("{BASE}/auth/recovery-info"));
    // The setup token is the bearer (`getFromServer('/auth/recovery-info', setupToken)`),
    // never the access token.
    assert_eq!(
        calls[0].headers.get("authorization").map(String::as_str),
        Some(format!("Bearer {}", setup_token("jti-setup")).as_str())
    );
}

#[tokio::test]
async fn recovery_info_without_a_verifier_is_malformed() {
    // `routes/auth.ts:687-690` answers `keyVerifier: null` for an account whose
    // verifier column is empty; Electron's `z.string()` rejects it, and so does this.
    for body in [
        r#"{"kdfSalt":"c2FsdA=="}"#,
        r#"{"kdfSalt":"c2FsdA==","keyVerifier":null}"#,
    ] {
        let (session, _) = holding_setup_token(vec![response(200, body)]);
        let result = session.recovery_info().await;
        assert!(
            matches!(
                result,
                Err(AuthError::Api {
                    source: ApiError::MalformedResponse { .. }
                })
            ),
            "{body}: {result:?}"
        );
    }
}

#[tokio::test]
async fn recovery_info_for_an_account_without_keys_crosses_as_its_400() {
    let (session, _) = holding_setup_token(vec![error_response(
        400,
        "VALIDATION_ERROR",
        "No encryption keys configured",
    )]);
    let result = session.recovery_info().await;
    assert!(
        matches!(
            result,
            Err(AuthError::Api {
                source: ApiError::Status { status: 400, .. }
            })
        ),
        "{result:?}"
    );
}

#[tokio::test]
async fn recovery_info_without_a_setup_token_makes_no_request() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport.clone(), FakeSecureStore::new());
    let result = session.recovery_info().await;
    assert!(matches!(result, Err(AuthError::NoSetupToken)), "{result:?}");
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn a_spent_code_is_not_posted_twice_on_a_5xx() {
    // Google redeems a code once; a 5xx after the server exchanged it must not
    // be retried into a refusal. Electron's `postToServer` does not retry.
    let (session, transport, _) = opened(vec![error_response(503, "INTERNAL_ERROR", "busy")]);
    let result = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await;
    assert!(matches!(result, Err(AuthError::Api { .. })), "{result:?}");
    assert_eq!(transport.call_count(), 1);
    assert_eq!(session.state(), AuthState::SignedOut);
}

// The paused clock orders the sleeps, so the interleaving does not depend on the runner.
#[tokio::test(start_paused = true)]
async fn an_answer_for_an_abandoned_attempt_stores_nothing() {
    let transport = FakeTransport::slow(vec![callback_ok("jti-late", false)], 50);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            STATE.to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();

    let (late, ()) = tokio::join!(
        session.complete_provider_web_callback("auth-code".to_string(), STATE.to_string()),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            session.abandon_provider_sign_in().unwrap();
        },
    );
    assert!(
        matches!(late, Err(AuthError::InvalidState { .. })),
        "{late:?}"
    );
    assert_eq!(session.state(), AuthState::SignedOut);
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

// The paused clock orders the sleeps, so the interleaving does not depend on the runner.
#[tokio::test(start_paused = true)]
async fn an_answer_for_an_abandoned_attempt_leaves_the_next_attempt_waiting() {
    let transport = FakeTransport::slow(vec![callback_ok("jti-late", false)], 50);
    let store = FakeSecureStore::new();
    let session = session(transport.clone(), store.clone());
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            STATE.to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();

    let (late, ()) = tokio::join!(
        session.complete_provider_web_callback("auth-code".to_string(), STATE.to_string()),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            session.abandon_provider_sign_in().unwrap();
            session
                .begin_provider_web_sign_in(
                    AuthProvider::Google,
                    "state-jwt-2".to_string(),
                    REDIRECT.to_string(),
                )
                .unwrap();
        },
    );
    // The old answer was signed over the old nonce; it must not move the new attempt.
    assert!(
        matches!(late, Err(AuthError::InvalidState { .. })),
        "{late:?}"
    );
    assert_eq!(session.state(), awaiting());
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test]
async fn a_setup_token_that_expires_while_reading_recovery_info_is_renewable() {
    // The user spends long enough finding the phrase that the setup token ages out:
    // `recovery-info` answers 401, which is the `SetupExpired` edge `register_device`
    // also takes, so renewal recovers it (Electron checks expiry first,
    // `setup-token.ts:108-112`).
    let (session, _, store) = opened(vec![
        callback_ok("jti-web", false),
        error_response(401, "AUTH_INVALID_TOKEN", "Setup token expired"),
        response(
            200,
            &json!({ "success": true, "setupToken": setup_token("jti-renewed") }).to_string(),
        ),
    ]);
    session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .unwrap();

    let read = session.recovery_info().await;
    assert!(
        matches!(
            read,
            Err(AuthError::Api {
                source: ApiError::Unauthorized { .. }
            })
        ),
        "{read:?}"
    );
    assert_eq!(session.state(), AuthState::SetupExpired);

    assert_eq!(
        session.renew_setup_token().await.unwrap(),
        AuthState::SetupPending
    );
    assert_eq!(
        store.text(SecureStoreKey::SetupToken),
        Some(setup_token("jti-renewed"))
    );
}

/// A store whose first `clear` stops until the test releases it, so a sign-out can be held
/// inside its clear while another call runs.
struct ClearGate {
    inner: Arc<FakeSecureStore>,
    armed: Mutex<Option<(Sender<()>, Receiver<()>)>>,
}

impl SecureStore for ClearGate {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        self.inner.get(key)
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.inner.set(key, value)
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.inner.delete(key)
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        let armed = self.armed.lock().unwrap().take();
        if let Some((entered, release)) = armed {
            entered.send(()).unwrap();
            release.recv().unwrap();
        }
        self.inner.clear()
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn a_sign_out_racing_a_callback_never_strands_setup_pending() {
    let transport = FakeTransport::new(vec![callback_ok("jti-late", false)]);
    let inner = FakeSecureStore::new();
    let (entered_tx, entered) = channel();
    let (release, release_rx) = channel();
    let store = Arc::new(ClearGate {
        inner: inner.clone(),
        armed: Mutex::new(Some((entered_tx, release_rx))),
    });
    let session = session(transport, store);
    session
        .begin_provider_web_sign_in(
            AuthProvider::Google,
            STATE.to_string(),
            REDIRECT.to_string(),
        )
        .unwrap();

    std::thread::scope(|scope| {
        let signing_out = scope.spawn(|| block_on(session.sign_out()));
        // Sign-out is inside its store clear: the tokens are going, the attempt is not yet
        // ended.
        entered.recv().unwrap();
        let (answered_tx, answered) = channel();
        let session = &session;
        let answering = scope.spawn(move || {
            let late = block_on(
                session.complete_provider_web_callback("auth-code".to_string(), STATE.to_string()),
            );
            answered_tx.send(()).unwrap();
            late
        });
        // Without the lock order the callback completes here, between the clear and the
        // attempt's reset, and stores a setup token sign-out has already cleared past. With
        // it the callback waits for sign-out, and this wait gives up; its expiry fails nothing.
        let _ = answered.recv_timeout(Duration::from_millis(500));
        release.send(()).unwrap();
        signing_out.join().unwrap().ok();
        let late = answering.join().unwrap();
        assert!(
            matches!(late, Err(AuthError::InvalidState { .. })),
            "{late:?}"
        );
    });

    assert_ne!(session.state(), AuthState::SetupPending);
    assert_eq!(inner.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test]
async fn a_web_sign_in_without_a_state_or_redirect_opens_nothing() {
    let transport = FakeTransport::new(vec![]);
    let session = session(transport, FakeSecureStore::new());
    for (state, redirect) in [("", REDIRECT), (STATE, "")] {
        let opened = session.begin_provider_web_sign_in(
            AuthProvider::Google,
            state.to_string(),
            redirect.to_string(),
        );
        assert!(
            matches!(opened, Err(AuthError::InvalidState { .. })),
            "{opened:?}"
        );
        assert_eq!(session.state(), AuthState::SignedOut);
    }
}

// Electron drops an attempt ten minutes after it opened (`auth-oauth-state.ts:14,32-35`).
#[tokio::test(start_paused = true)]
async fn a_callback_after_ten_minutes_is_refused_and_spent() {
    let (session, transport, store) = opened(vec![]);
    tokio::time::advance(Duration::from_secs(10 * 60 + 1)).await;

    for _ in 0..2 {
        let late = session
            .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
            .await;
        assert!(
            matches!(late, Err(AuthError::InvalidState { .. })),
            "{late:?}"
        );
    }
    assert_eq!(transport.call_count(), 0);
    assert_eq!(store.text(SecureStoreKey::SetupToken), None);
}

#[tokio::test(start_paused = true)]
async fn a_callback_inside_ten_minutes_is_taken() {
    let (session, _, _) = opened(vec![callback_ok("jti-web", false)]);
    tokio::time::advance(Duration::from_secs(10 * 60)).await;
    let outcome = session
        .complete_provider_web_callback("auth-code".to_string(), STATE.to_string())
        .await
        .unwrap();
    assert_eq!(outcome.state, AuthState::SetupPending);
}

#[test]
fn callback_credentials_stay_out_of_debug_output() {
    use memry_core::protocol::auth::{OAuthCallbackRequest, OAuthSignInResponse};
    let request = OAuthCallbackRequest {
        code: "secret-code".to_string(),
        state: "secret-state".to_string(),
        redirect_uri: REDIRECT.to_string(),
        session_nonce: "nonce".to_string(),
        device_public_key: "key".to_string(),
    };
    let response: OAuthSignInResponse = serde_json::from_value(
        json!({ "success": true, "setupToken": setup_token("jti-printed") }),
    )
    .unwrap();
    let printed = format!("{request:?} {response:?}");
    for secret in ["secret-code", "secret-state", &setup_token("jti-printed")] {
        assert!(!printed.contains(secret), "a credential leaked");
    }
}
