//! Email sign-in, first-device setup, the recovery phrase and the account summary
//! (`apps/desktop/src/main/ipc/auth-device-handlers.ts`, `auth-oauth-handlers.ts`). Each command
//! calls one `AccountService` method; the renderer wraps the answers into Electron's
//! `{ success, error, errorCode }` envelopes (`services/auth-service.ts`).

use std::sync::Arc;

use memry_desktop::account::otp_clipboard::OtpClipboardWatch;
use memry_desktop::account::{AccountError, AccountService, OAuthEvent};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::transport::NoRedirectTransport;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::error::{CommandError, ErrorKind, log_failure};
use crate::events::{
    AuthOauthCallbackEvent, AuthOauthErrorEvent, AuthOtpDetectedEvent, AuthSessionRefreshedEvent,
    broadcast,
};
use crate::shell::external::open_url;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthOtpSent {
    /// Seconds the code lives, when the server says.
    pub expires_in: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthOtpVerified {
    pub is_new_user: bool,
    pub needs_setup: bool,
    pub needs_recovery_input: bool,
    /// Set when the device signed back in as a known device, without the phrase.
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthRefreshResult {
    pub success: bool,
    /// True only when the server refused the session and a new sign-in is needed.
    pub session_ended: bool,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthOAuthStarted {
    pub state: String,
    /// Shown for copying when the browser did not open.
    pub authorization_url: String,
    pub browser_opened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthOAuthRetried {
    pub browser_opened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthFirstDevice {
    pub needs_recovery_setup: bool,
    pub needs_recovery_input: bool,
    /// Set when this device is set up or signed back in without the phrase.
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountDevice {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfoView {
    pub signed_in: bool,
    pub email: Option<String>,
    pub device_id: Option<String>,
    pub needs_recovery_confirmation: bool,
}

fn account(app: &AppHandle<Wry>) -> Arc<AccountService> {
    app.state::<Arc<AccountService>>().inner().clone()
}

/// The core mapping, with Electron's translated sentence for the failures the user acts on
/// (`errors:auth.*`). The message never carries the phrase: `InvalidPhrase` drops the word.
fn map_error(app: &AppHandle<Wry>, command: &str, error: &AccountError) -> CommandError {
    let mut mapped = CommandError::from_core(error);
    let key = match error {
        AccountError::SetupSessionExpired => Some("errors:auth.setupSessionExpired"),
        AccountError::PhraseMismatch => Some("errors:auth.recoveryPhraseMismatch"),
        AccountError::InvalidPhrase => Some("errors:auth.invalidRecoveryPhraseFormat"),
        AccountError::OAuthExpired => Some("errors:auth.oauthExpired"),
        AccountError::OAuthInvalidResponse => Some("errors:auth.oauthInvalidResponse"),
        _ => None,
    };
    if let Some(key) = key {
        mapped.message = translated(app, key);
    }
    log_failure(command, &mapped);
    mapped
}

/// Electron reads the clipboard from the code request until the code is verified
/// (`auth-device-handlers.ts:254-262`). Off the main thread: the watch runs on the async runtime.
fn watch_clipboard(app: &AppHandle<Wry>) {
    let reader = app.clone();
    let emitter = app.clone();
    app.state::<OtpClipboardWatch>().start(
        move || reader.clipboard().read_text().ok(),
        move |code| broadcast(&emitter, AuthOtpDetectedEvent { code }),
    );
}

fn translated(app: &AppHandle<Wry>, key: &str) -> String {
    i18n::t(app.state::<Arc<LocaleService>>().get(), key, &Args::new())
}

/// Electron's `openOAuthBrowser`: the platform error may carry the URL and its state, so only
/// the fact is logged.
fn open_browser(app: &AppHandle<Wry>, url: &str) -> bool {
    let opened = open_url(app, url).is_ok();
    if !opened {
        tracing::warn!(scope = "Account", "could not open the sign-in browser");
    }
    opened
}

fn seconds(expires_in: Option<u64>) -> AuthOtpSent {
    AuthOtpSent {
        expires_in: expires_in.map(|s| u32::try_from(s).unwrap_or(u32::MAX)),
    }
}

/// `sync:auth-request-otp`.
#[tauri::command]
#[specta::specta]
pub async fn auth_request_otp(
    app: AppHandle<Wry>,
    email: String,
) -> Result<AuthOtpSent, CommandError> {
    watch_clipboard(&app);
    account(&app)
        .request_otp(email)
        .await
        .map(seconds)
        .map_err(|e| map_error(&app, "auth_request_otp", &e))
}

/// `sync:auth-resend-otp`, to the address of the pending request.
#[tauri::command]
#[specta::specta]
pub async fn auth_resend_otp(app: AppHandle<Wry>) -> Result<AuthOtpSent, CommandError> {
    watch_clipboard(&app);
    account(&app)
        .resend_otp()
        .await
        .map(seconds)
        .map_err(|e| map_error(&app, "auth_resend_otp", &e))
}

/// `sync:auth-verify-otp`, then the known-device path.
#[tauri::command]
#[specta::specta]
pub async fn auth_verify_otp(
    app: AppHandle<Wry>,
    code: String,
) -> Result<AuthOtpVerified, CommandError> {
    let verified = account(&app)
        .verify_otp(code)
        .await
        .map_err(|e| map_error(&app, "auth_verify_otp", &e))?;
    app.state::<OtpClipboardWatch>().stop();
    Ok(AuthOtpVerified {
        is_new_user: verified.is_new_user,
        needs_setup: verified.needs_setup,
        needs_recovery_input: verified.needs_recovery_input,
        device_id: verified.device_id,
    })
}

/// `sync:auth-refresh-token`.
#[tauri::command]
#[specta::specta]
pub async fn auth_refresh_token(app: AppHandle<Wry>) -> Result<AuthRefreshResult, CommandError> {
    let outcome = account(&app).refresh().await;
    if outcome.success {
        broadcast(&app, AuthSessionRefreshedEvent {});
    }
    Ok(AuthRefreshResult {
        success: outcome.success,
        session_ended: outcome.session_ended,
    })
}

/// `sync:setup-new-account`. The phrase waits for `sync_get_recovery_phrase`.
#[tauri::command]
#[specta::specta]
pub async fn sync_setup_new_account(app: AppHandle<Wry>) -> Result<AccountDevice, CommandError> {
    account(&app)
        .setup_new_account()
        .await
        .map(|device_id| AccountDevice { device_id })
        .map_err(|e| map_error(&app, "sync_setup_new_account", &e))
}

/// `sync:get-recovery-phrase`: the phrase of the setup, until it is confirmed.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_recovery_phrase(app: AppHandle<Wry>) -> Result<Option<String>, CommandError> {
    Ok(account(&app)
        .recovery_phrase()
        .map(|phrase| phrase.as_str().to_owned()))
}

/// `sync:confirm-recovery-phrase`.
#[tauri::command]
#[specta::specta]
pub async fn sync_confirm_recovery_phrase(
    app: AppHandle<Wry>,
    confirmed: bool,
) -> Result<(), CommandError> {
    account(&app)
        .confirm_recovery_phrase(confirmed)
        .map_err(|e| map_error(&app, "sync_confirm_recovery_phrase", &e))
}

/// `sync:link-via-recovery`.
#[tauri::command]
#[specta::specta]
pub async fn sync_link_via_recovery(
    app: AppHandle<Wry>,
    recovery_phrase: String,
) -> Result<AccountDevice, CommandError> {
    account(&app)
        .link_via_recovery(recovery_phrase)
        .await
        .map(|device_id| AccountDevice { device_id })
        .map_err(|e| map_error(&app, "sync_link_via_recovery", &e))
}

/// The account as the renderer shows it at launch, from the keychain and `memry-config.json`
/// alone: offline or waiting on a refresh still reads as signed in.
#[tauri::command]
#[specta::specta]
pub async fn account_get_info(app: AppHandle<Wry>) -> Result<AccountInfoView, CommandError> {
    let service = account(&app);
    let info = tauri::async_runtime::spawn_blocking(move || service.info())
        .await
        .map_err(|e| {
            CommandError::new(
                super::error::ErrorKind::Internal,
                "account_info",
                e.to_string(),
            )
        })?;
    Ok(AccountInfoView {
        signed_in: info.signed_in,
        email: info.email,
        device_id: info.device_id,
        needs_recovery_confirmation: info.needs_recovery_confirmation,
    })
}

/// `sync:auth-init-oauth`: the loopback waits, the browser opens on Google's page, and the
/// loopback's one answer arrives as an event.
#[tauri::command]
#[specta::specta]
pub async fn auth_init_oauth(app: AppHandle<Wry>) -> Result<AuthOAuthStarted, CommandError> {
    let probe = app.state::<NoRedirectTransport>().inner().clone();
    let emitter = app.clone();
    let started = account(&app)
        .init_oauth(probe.as_ref(), move |event| match event {
            OAuthEvent::Callback { code, state } => {
                broadcast(&emitter, AuthOauthCallbackEvent { code, state });
            }
            OAuthEvent::Cancelled => broadcast(
                &emitter,
                AuthOauthErrorEvent {
                    error: translated(&emitter, "errors:auth.oauthCancelled"),
                },
            ),
            OAuthEvent::Expired => broadcast(
                &emitter,
                AuthOauthErrorEvent {
                    error: translated(&emitter, "errors:auth.oauthExpired"),
                },
            ),
        })
        .await
        .map_err(|e| map_error(&app, "auth_init_oauth", &e))?;
    let browser_opened = open_browser(&app, &started.authorization_url);
    Ok(AuthOAuthStarted {
        state: started.state,
        authorization_url: started.authorization_url,
        browser_opened,
    })
}

/// `sync:auth-retry-oauth`: reopens the browser of the attempt still waiting.
#[tauri::command]
#[specta::specta]
pub async fn auth_retry_oauth(
    app: AppHandle<Wry>,
    state: String,
) -> Result<AuthOAuthRetried, CommandError> {
    let url = account(&app)
        .oauth_retry_url(&state)
        .map_err(|e| map_error(&app, "auth_retry_oauth", &e))?;
    Ok(AuthOAuthRetried {
        browser_opened: open_browser(&app, &url),
    })
}

/// `sync:setup-first-device`: the browser's code, exchanged once.
#[tauri::command]
#[specta::specta]
pub async fn sync_setup_first_device(
    app: AppHandle<Wry>,
    provider: String,
    oauth_token: String,
    state: String,
) -> Result<AuthFirstDevice, CommandError> {
    if provider != "google" {
        let error = CommandError::new(
            ErrorKind::Invalid,
            "unknown_provider",
            "only Google sign-in is supported",
        );
        log_failure("sync_setup_first_device", &error);
        return Err(error);
    }
    account(&app)
        .setup_first_device(oauth_token, state)
        .await
        .map(|first| AuthFirstDevice {
            needs_recovery_setup: first.needs_recovery_setup,
            needs_recovery_input: first.needs_recovery_input,
            device_id: first.device_id,
        })
        .map_err(|e| map_error(&app, "sync_setup_first_device", &e))
}
