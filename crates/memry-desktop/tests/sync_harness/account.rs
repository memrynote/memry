//! `AccountService` against the real Worker: email sign-in, first-device setup with the phrase,
//! the known-device sign-in (`sync/device-registration.ts:285-327`), the phrase after a sign-out
//! (`ipc/auth-device-handlers.ts:427-489`), a wrong code followed by the right one, and a setup
//! another device finished first.

use std::sync::Arc;

use memry_core::api::auth::AuthState;
use memry_core::api::errors::{ApiError, AuthError};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::account::{AccountError, AccountService, OtpVerified, device};
use memry_desktop::registry::config::AppConfig;
use memry_desktop::seams::transport::app_transport;

use super::{NoPins, Server, device_key};

const EMAIL: &str = "Harness-Account@Example.com";
const CODE: &str = "424242";

/// A fresh install's config over `store`.
fn install(server: &Server, store: Arc<dyn SecureStore>) -> (tempfile::TempDir, AccountService) {
    let dir = tempfile::tempdir().unwrap();
    let service = AccountService::new(
        app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        store,
        server.url.clone(),
        device::descriptor("1.0.0"),
        Arc::new(AppConfig::load(dir.path().join("memry-config.json"))),
    )
    .unwrap();
    (dir, service)
}

async fn sign_in(server: &mut Server, account: &AccountService) -> OtpVerified {
    account.request_otp(EMAIL.into()).await.expect("a code");
    server.otp(EMAIL, CODE);
    account
        .verify_otp(CODE.into())
        .await
        .expect("a verified code")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_email_sign_in_sets_up_signs_back_in_known_and_asks_for_the_phrase_after_sign_out() {
    let mut server = Server::start();
    let store = device_key::with_device_key();

    // A new account: the phrase is made, the device registered, the key published.
    let (_first_dir, first) = install(&server, store.clone());
    let verified = sign_in(&mut server, &first).await;
    assert!(verified.needs_setup, "{verified:?}");
    let device_id = first.setup_new_account().await.expect("setup");
    let phrase = first.recovery_phrase().expect("the phrase until confirmed");
    first.confirm_recovery_phrase(true).unwrap();
    assert!(first.recovery_phrase().is_none());
    let info = first.info();
    assert!(
        info.signed_in && !info.needs_recovery_confirmation,
        "{info:?}"
    );
    assert_eq!(info.device_id.as_deref(), Some(device_id.as_str()));

    // A fresh config over a keychain that kept the device's keys and lost its tokens: back in
    // without the phrase, as the same server device.
    let kept = device_key::with_device_key();
    let master = store
        .get(SecureStoreKey::MasterKey)
        .unwrap()
        .expect("a master key");
    kept.set(SecureStoreKey::MasterKey, master).unwrap();
    let (_second_dir, second) = install(&server, kept.clone());
    let verified = sign_in(&mut server, &second).await;
    assert!(
        !verified.needs_setup && !verified.needs_recovery_input,
        "{verified:?}"
    );
    assert_eq!(verified.device_id.as_deref(), Some(device_id.as_str()));
    assert_eq!(second.info().device_id.as_deref(), Some(device_id.as_str()));

    // A sign-out clears the keys: the next sign-in needs the phrase, which brings the account's
    // key back.
    second.session().sign_out().await.expect("sign out");
    let verified = sign_in(&mut server, &second).await;
    assert!(
        verified.needs_recovery_input && verified.device_id.is_none(),
        "{verified:?}"
    );
    second
        .link_via_recovery(phrase.to_string())
        .await
        .expect("the phrase links the device");
    assert!(second.info().signed_in);
}

/// The Worker answers a wrong code `401 AUTH_INVALID_OTP` and counts it; the attempt stays on the
/// code, a resend works, and the right code still reaches setup and the phrase.
#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_code_keeps_the_attempt_and_the_right_code_sets_up() {
    let mut server = Server::start();
    let (_dir, account) = install(&server, device_key::with_device_key());
    account.request_otp(EMAIL.into()).await.expect("a code");
    server.otp(EMAIL, CODE);

    let error = account.verify_otp("000000".into()).await.unwrap_err();

    assert!(
        matches!(
            error,
            AccountError::Auth(AuthError::Api {
                source: ApiError::Unauthorized { .. }
            })
        ),
        "{error:?}"
    );
    assert!(matches!(
        account.session().state(),
        AuthState::AwaitingOtp { .. }
    ));
    account.resend_otp().await.expect("a resend");
    server.otp(EMAIL, CODE);
    let verified = account
        .verify_otp(CODE.into())
        .await
        .expect("the right code");
    assert!(verified.needs_setup, "{verified:?}");
    account.setup_new_account().await.expect("setup");
    assert!(account.recovery_phrase().is_some());
}

/// Two devices verify a code for a new account; the second to publish its keys gets the Worker's
/// `409`, is not signed in, and the first device's phrase links it as the device it registered.
#[tokio::test(flavor = "multi_thread")]
async fn a_setup_another_device_finished_first_links_with_its_phrase() {
    let mut server = Server::start();
    let (_first_dir, first) = install(&server, device_key::with_device_key());
    let (_second_dir, second) = install(&server, device_key::without_device_key());
    assert!(sign_in(&mut server, &first).await.needs_setup);
    assert!(sign_in(&mut server, &second).await.needs_setup);
    first.setup_new_account().await.expect("the first setup");
    let phrase = first.recovery_phrase().expect("the first phrase");

    let error = second.setup_new_account().await.unwrap_err();

    assert!(matches!(error, AccountError::SetupConflict), "{error:?}");
    assert!(second.recovery_phrase().is_none());
    assert!(!second.info().signed_in);
    let device_id = second
        .link_via_recovery(phrase.to_string())
        .await
        .expect("the account's phrase links it");
    let info = second.info();
    assert!(info.signed_in, "{info:?}");
    assert_eq!(info.device_id.as_deref(), Some(device_id.as_str()));
    assert_eq!(second.session().registered_device_id().unwrap(), device_id);
}
