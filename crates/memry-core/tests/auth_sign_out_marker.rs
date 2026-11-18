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
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
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

/// #4766: a sign-out the keychain refused leaves the device key behind. The next sign-in, of any
/// account, deletes it first and registers a new one, so the next account never signs as this
/// device's last account.
#[tokio::test]
async fn a_new_sign_in_never_reuses_the_device_key_a_refused_sign_out_kept() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("signed-out");
    let (session, _transport, store) = refused_sign_out(&marker, sign_in_script("jti-2")).await;
    let kept = store.get(SecureStoreKey::DeviceSigningKey).unwrap();
    assert!(kept.is_some(), "the refused sign-out kept the device key");

    session
        .request_email_code("next@example.com".to_string())
        .await
        .unwrap();
    assert_eq!(store.get(SecureStoreKey::DeviceSigningKey).unwrap(), None);
    assert_eq!(store.text(SecureStoreKey::RefreshToken), None);
    session
        .verify_email_code("123456".to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap();

    let registered = store.get(SecureStoreKey::DeviceSigningKey).unwrap();
    assert!(registered.is_some());
    assert_ne!(registered, kept);
}

/// A sign-out the keychain carried out keeps the device key a later local write mints: only a
/// refused one sends the next sign-in through the delete.
#[tokio::test]
async fn a_clean_sign_out_keeps_the_key_minted_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut script = sign_in_script("jti-1");
    script.push(response(200, "{}"));
    script.push(response(200, r#"{"success":true,"expiresIn":600}"#));
    let store = FakeSecureStore::new();
    let session = launch(
        FakeTransport::new(script),
        store.clone(),
        &dir.path().join("signed-out"),
    );
    sign_in(&session).await;
    session.sign_out().await.unwrap();
    memry_core::api::auth::ensure_device_identity(store.clone()).unwrap();
    let minted = store.get(SecureStoreKey::DeviceSigningKey).unwrap();

    session
        .request_email_code("next@example.com".to_string())
        .await
        .unwrap();

    assert!(minted.is_some());
    assert_eq!(store.get(SecureStoreKey::DeviceSigningKey).unwrap(), minted);
}

/// A marker path whose existence cannot be read counts as a sign-out (the fail-closed side), and
/// the failure reaches the shell.
#[cfg(unix)]
#[tokio::test]
async fn an_unreadable_marker_refuses_the_restore_and_reports_why() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-dir");
    std::fs::write(&file, b"").unwrap();
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::RefreshToken, "refresh-from-the-last-run");

    let session = launch(
        FakeTransport::new(Vec::new()),
        store,
        &file.join("signed-out"),
    );

    assert_eq!(session.restore().unwrap(), AuthState::SignedOut);
    assert!(session.take_sign_out_marker_fault().is_some());
}

/// A sign-out from a state with no edge, whose clear the keychain refused, is not restored after
/// a relaunch either.
#[tokio::test]
async fn a_refused_clear_without_an_edge_is_not_restored_after_a_relaunch() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("signed-out");
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::RefreshToken, "refresh-from-the-last-run");
    store.fail_clear();
    let session = launch(FakeTransport::new(Vec::new()), store.clone(), &marker);

    session.clear_without_edge().unwrap_err();
    drop(session);
    let relaunched = launch(FakeTransport::new(Vec::new()), store, &marker);

    assert_eq!(relaunched.restore().unwrap(), AuthState::SignedOut);
}

/// A marker write that fails and a later one that succeeds leave nothing to report: the file is
/// there, so the next launch refuses the restore.
#[tokio::test]
async fn a_marker_written_after_a_failed_write_reports_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("app");
    std::fs::write(&parent, b"").unwrap();
    let marker = parent.join("signed-out");
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::RefreshToken, "refresh-from-the-last-run");
    store.fail_clear();
    let session = launch(FakeTransport::new(Vec::new()), store, &marker);
    session.clear_without_edge().unwrap_err();

    std::fs::remove_file(&parent).unwrap();
    session.clear_without_edge().unwrap_err();

    assert!(marker.exists());
    assert_eq!(session.take_sign_out_marker_fault(), None);
}

/// A marker that registration could not remove (the folder refused it) is moot once the next
/// refused sign-out writes it again: that sign-out reports no restore risk.
#[cfg(unix)]
#[tokio::test]
async fn a_failed_removal_at_registration_is_moot_once_the_next_sign_out_writes_the_marker() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("app");
    let marker = parent.join("signed-out");
    let mut extra = sign_in_script("jti-2");
    extra.push(response(200, "{}"));
    let (session, _transport, _store) = refused_sign_out(&marker, extra).await;
    assert_eq!(session.take_sign_out_marker_fault(), None);
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o555)).unwrap();

    sign_in(&session).await;
    let refused = session.sign_out().await;
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(refused, Err(AuthError::SecureStore { .. })));
    assert!(marker.exists());
    assert_eq!(session.take_sign_out_marker_fault(), None);
}

/// A marker path that could not be read or cleared at sign-in, and holds no file by the time
/// the device registers, leaves nothing to report.
#[cfg(unix)]
#[tokio::test]
async fn a_marker_fault_at_sign_in_is_dropped_once_registration_finds_no_marker() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("app");
    std::fs::write(&parent, b"").unwrap();
    let session = launch(
        FakeTransport::new(sign_in_script("jti-1")),
        FakeSecureStore::new(),
        &parent.join("signed-out"),
    );
    session
        .request_email_code("kaan@example.com".to_string())
        .await
        .unwrap();

    std::fs::remove_file(&parent).unwrap();
    session
        .verify_email_code("123456".to_string())
        .await
        .unwrap();
    session.register_device().await.unwrap();

    assert_eq!(session.take_sign_out_marker_fault(), None);
}
