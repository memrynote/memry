//! #4767: a sign-out the keychain refused stays a sign-out after a restart. Each "relaunch" is a
//! second `AuthSession` over the same store and the same marker path, which is what the next
//! process builds.

#[allow(unused_imports)]
use crate::http_fakes;

use std::path::Path;
use std::sync::Arc;

use http_fakes::*;
use memry_core::api::auth::{AuthSession, AuthState, DeviceDescriptor};
use memry_core::api::errors::AuthError;
use memry_core::api::errors::TransportError;
use memry_core::protocol::auth::{DeviceFormFactor, DevicePlatform};
use memry_core::seams::secure_store::SecureStoreKey;
use memry_core::seams::transport::HttpResponse;
use serde_json::json;

fn launch(
    transport: Arc<FakeTransport>,
    store: Arc<FakeSecureStore>,
    marker: &Path,
) -> AuthSession {
    AuthSession::new(
        transport,
        store,
        "https://sync.example.com".to_string(),
        "ios".to_string(),
        DeviceDescriptor {
            name: "Phone".to_string(),
            platform: DevicePlatform::Ios,
            form_factor: Some(DeviceFormFactor::Phone),
            os_version: Some("26.0".to_string()),
            app_version: "1.4.2".to_string(),
            vault_id: None,
        },
        Some(marker.to_string_lossy().into_owned()),
    )
    .unwrap()
}

fn sign_in_script(jti: &str) -> Vec<Result<HttpResponse, TransportError>> {
    let setup =
        jwt(json!({ "sub": "user-1", "jti": jti, "exp": 4_102_444_800u64, "type": "setup" }));
    vec![
        response(200, r#"{"success":true,"expiresIn":600}"#),
        response(
            200,
            &format!(r#"{{"success":true,"setupToken":"{setup}"}}"#),
        ),
        response(
            200,
            r#"{"success":true,"deviceId":"device-1","accessToken":"access-1","refreshToken":"refresh-1"}"#,
        ),
    ]
}

async fn sign_in(session: &AuthSession) {
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
}

/// Signs in, then signs out over a keychain that refuses the clear: the refresh token stays.
async fn refused_sign_out(
    marker: &Path,
    extra: Vec<Result<HttpResponse, TransportError>>,
) -> (AuthSession, Arc<FakeTransport>, Arc<FakeSecureStore>) {
    let mut script = sign_in_script("jti-1");
    script.push(response(200, "{}"));
    script.extend(extra);
    let transport = FakeTransport::new(script);
    let store = FakeSecureStore::new();
    let session = launch(transport.clone(), store.clone(), marker);
    sign_in(&session).await;
    store.fail_clear();
    assert!(matches!(
        session.sign_out().await.unwrap_err(),
        AuthError::SecureStore { .. }
    ));
    assert!(store.text(SecureStoreKey::RefreshToken).is_some());
    (session, transport, store)
}

#[tokio::test]
async fn a_refused_sign_out_is_not_restored_after_a_relaunch() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("app").join("signed-out");
    let (first, transport, store) = refused_sign_out(&marker, Vec::new()).await;
    drop(first);

    let relaunched = launch(transport, store, &marker);

    assert_eq!(relaunched.restore().unwrap(), AuthState::SignedOut);
}

/// A fresh install, an install from before the marker and an Electron import have no marker
/// file: the refresh token in the keychain restores the session.
#[tokio::test]
async fn an_install_without_a_marker_restores() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::RefreshToken, "refresh-from-the-last-run");

    let session = launch(
        FakeTransport::new(Vec::new()),
        store,
        &dir.path().join("signed-out"),
    );

    assert_eq!(session.restore().unwrap(), AuthState::Registered);
}

/// Signing in again after the refused sign-out removes the marker, so the next launch restores
/// the new session.
#[tokio::test]
async fn signing_in_again_lets_the_next_launch_restore() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("signed-out");
    let (first, transport, store) = refused_sign_out(&marker, sign_in_script("jti-2")).await;
    sign_in(&first).await;
    drop(first);

    let relaunched = launch(transport, store, &marker);

    assert_eq!(relaunched.restore().unwrap(), AuthState::Registered);
}

/// A sign-out the keychain carried out leaves no marker: nothing is left to restore, and a later
/// build or an Electron rollback that signs in is not refused.
#[tokio::test]
async fn a_clean_sign_out_leaves_no_marker() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("signed-out");
    let mut script = sign_in_script("jti-1");
    script.push(response(200, "{}"));
    let session = launch(FakeTransport::new(script), FakeSecureStore::new(), &marker);
    sign_in(&session).await;

    assert_eq!(session.sign_out().await.unwrap(), AuthState::SignedOut);

    assert!(!marker.exists());
}
