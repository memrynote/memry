//! Auth and sync_auth/sync_setup command surface.
//!
//! Each `#[tauri::command]` is a thin async wrapper over a `*_inner`
//! function that takes `&AppState`. Tests target the inner; the Tauri
//! wrapper just unwraps `tauri::State` and forwards.
//!
//! Naming follows the M4 plan: legacy Electron channels like
//! `auth:request-otp` map to `sync_auth_request_otp`, with a small set
//! of `auth_*` aliases preserved (`auth_request_otp`, `auth_submit_otp`)
//! for the unlock-screen call paths.

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::auth::account::{
    self, OtpRequestResult, OtpVerifyResult, SetupAccountInput, SetupAccountResult,
};
use crate::auth::device::{self, CurrentDeviceRecord};
use crate::auth::types::AuthStatus;
use crate::auth::vault_keys;
use crate::error::{AppError, AppResult};
use crate::sync::auth_client;

// ---------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthUnlockInput {
    pub password: String,
    pub remember_device: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequestOtpInput {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthSubmitOtpInput {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthRegisterDeviceInput {
    pub name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    pub ok: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceView {
    pub device_id: String,
    pub signing_public_key: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OtpRequestView {
    pub success: bool,
    pub expires_at: Option<i64>,
}

impl From<OtpRequestResult> for OtpRequestView {
    fn from(r: OtpRequestResult) -> Self {
        Self {
            success: r.success,
            expires_at: r.expires_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OtpVerifyView {
    pub success: bool,
    pub needs_setup: bool,
}

impl From<OtpVerifyResult> for OtpVerifyView {
    fn from(r: OtpVerifyResult) -> Self {
        Self {
            success: true,
            needs_setup: r.needs_setup,
        }
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InitOAuthInput {
    pub provider: String,
    pub redirect_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InitOAuthView {
    pub state: String,
    pub authorize_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenView {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LogoutView {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetupFirstDeviceInput {
    pub provider: String,
    pub oauth_token: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetupResultView {
    pub success: bool,
    pub error: Option<String>,
    pub device_id: Option<String>,
    pub email: Option<String>,
    pub recovery_phrase: Option<Vec<String>>,
    pub needs_recovery_setup: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetupNewAccountInput {
    pub email: String,
    pub password: String,
    pub remember_device: bool,
    pub device_name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmRecoveryPhraseInput {
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimpleSuccess {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPhraseView {
    pub phrase: String,
}

// ---------------------------------------------------------------------
// auth_status / auth_unlock / auth_lock / auth_enable_biometric
// ---------------------------------------------------------------------

pub fn auth_status_inner(state: &AppState) -> AuthStatus {
    state.auth.status()
}

#[tauri::command]
#[specta::specta]
pub async fn auth_status(state: tauri::State<'_, AppState>) -> AppResult<AuthStatus> {
    Ok(auth_status_inner(&state))
}

pub async fn auth_unlock_inner(state: &AppState, input: AuthUnlockInput) -> AppResult<AuthStatus> {
    vault_keys::unlock_with_password(state, input.password, input.remember_device).await
}

#[tauri::command]
#[specta::specta]
pub async fn auth_unlock(
    state: tauri::State<'_, AppState>,
    input: AuthUnlockInput,
) -> AppResult<AuthStatus> {
    auth_unlock_inner(&state, input).await
}

pub fn auth_lock_inner(state: &AppState) -> AppResult<()> {
    state.auth.lock()
}

#[tauri::command]
#[specta::specta]
pub async fn auth_lock(state: tauri::State<'_, AppState>) -> AppResult<()> {
    auth_lock_inner(&state)
}

pub async fn auth_enable_biometric_inner() -> AppResult<BiometricStatus> {
    Ok(BiometricStatus {
        ok: false,
        reason: "not-implemented-post-v1".to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn auth_enable_biometric() -> AppResult<BiometricStatus> {
    auth_enable_biometric_inner().await
}

// ---------------------------------------------------------------------
// auth_register_device
//
// Returns the local device id + base64 public key, generating the
// signing keypair on first call.
// ---------------------------------------------------------------------

pub fn auth_register_device_inner(
    state: &AppState,
    input: AuthRegisterDeviceInput,
) -> AppResult<RegisterDeviceView> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let kp = device::get_or_create_device_signing_key(state)?;
    let device_id = device::device_id_for_keypair(&kp)?;
    let signing_public_key = B64.encode(kp.public_key);

    device::upsert_current_device(
        state,
        CurrentDeviceRecord {
            id: device_id.clone(),
            name: input.name,
            platform: input.platform,
            os_version: input.os_version,
            app_version: input.app_version,
            linked_at: now_secs(),
            signing_public_key: signing_public_key.clone(),
        },
    )?;

    Ok(RegisterDeviceView {
        device_id,
        signing_public_key,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn auth_register_device(
    state: tauri::State<'_, AppState>,
    input: AuthRegisterDeviceInput,
) -> AppResult<RegisterDeviceView> {
    auth_register_device_inner(&state, input)
}

// ---------------------------------------------------------------------
// auth_request_otp / auth_submit_otp + sync_auth_* aliases
// ---------------------------------------------------------------------

pub async fn auth_request_otp_inner(
    state: &AppState,
    input: AuthRequestOtpInput,
) -> AppResult<OtpRequestView> {
    let r = account::request_otp(state, &input.email).await?;
    Ok(r.into())
}

#[tauri::command]
#[specta::specta]
pub async fn auth_request_otp(
    state: tauri::State<'_, AppState>,
    input: AuthRequestOtpInput,
) -> AppResult<OtpRequestView> {
    auth_request_otp_inner(&state, input).await
}

pub async fn auth_submit_otp_inner(
    state: &AppState,
    input: AuthSubmitOtpInput,
) -> AppResult<OtpVerifyView> {
    let r = account::verify_otp(state, &input.email, &input.code).await?;
    Ok(r.into())
}

#[tauri::command]
#[specta::specta]
pub async fn auth_submit_otp(
    state: tauri::State<'_, AppState>,
    input: AuthSubmitOtpInput,
) -> AppResult<OtpVerifyView> {
    auth_submit_otp_inner(&state, input).await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_request_otp(
    state: tauri::State<'_, AppState>,
    input: AuthRequestOtpInput,
) -> AppResult<OtpRequestView> {
    auth_request_otp_inner(&state, input).await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_verify_otp(
    state: tauri::State<'_, AppState>,
    input: AuthSubmitOtpInput,
) -> AppResult<OtpVerifyView> {
    auth_submit_otp_inner(&state, input).await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_resend_otp(
    _state: tauri::State<'_, AppState>,
    input: AuthRequestOtpInput,
) -> AppResult<OtpRequestView> {
    let base = crate::sync::http::resolve_base_url()?;
    let body = serde_json::json!({ "email": input.email });
    let r: OtpRequestResult = auth_client::resend_otp_with_base(&base, &body).await?;
    Ok(r.into())
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_init_o_auth(
    _state: tauri::State<'_, AppState>,
    input: InitOAuthInput,
) -> AppResult<InitOAuthView> {
    if input.provider != "google" {
        return Err(AppError::Validation(format!(
            "unsupported oauth provider: {}",
            input.provider
        )));
    }
    let redirect_uri = input
        .redirect_uri
        .unwrap_or_else(|| "memry://oauth/callback".to_string());
    let base = crate::sync::http::resolve_base_url()?;
    let resp: InitOAuthView =
        auth_client::init_google_oauth_with_base(&base, &redirect_uri).await?;
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_refresh_token(
    state: tauri::State<'_, AppState>,
) -> AppResult<RefreshTokenView> {
    match account::refresh_session(&state).await {
        Ok(()) => Ok(RefreshTokenView {
            success: true,
            error: None,
        }),
        Err(err) => Ok(RefreshTokenView {
            success: false,
            error: Some(redact_err(&err)),
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_auth_logout(state: tauri::State<'_, AppState>) -> AppResult<LogoutView> {
    match account::logout(&state) {
        Ok(()) => Ok(LogoutView {
            success: true,
            error: None,
        }),
        Err(err) => Ok(LogoutView {
            success: false,
            error: Some(redact_err(&err)),
        }),
    }
}

// ---------------------------------------------------------------------
// sync_setup_*
//
// `setup_first_device` (OAuth-driven) is deferred past M4: server-side
// OAuth callback wiring is not in scope for this milestone. The command
// returns an explicit failure so the renderer can render a "use OTP
// flow" affordance without crashing.
// ---------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn sync_setup_setup_first_device(
    _state: tauri::State<'_, AppState>,
    _input: SetupFirstDeviceInput,
) -> AppResult<SetupResultView> {
    Ok(SetupResultView {
        success: false,
        error: Some(
            "OAuth-based first-device setup is deferred to post-M4; use the OTP flow"
                .to_string(),
        ),
        device_id: None,
        email: None,
        recovery_phrase: None,
        needs_recovery_setup: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_setup_setup_new_account(
    state: tauri::State<'_, AppState>,
    input: SetupNewAccountInput,
) -> AppResult<SetupResultView> {
    let setup_input = SetupAccountInput {
        password: input.password,
        remember_device: input.remember_device,
        email: input.email.clone(),
        device_name: input.device_name,
        platform: input.platform,
        os_version: input.os_version,
        app_version: input.app_version,
    };
    match account::setup_new_account(&state, setup_input).await {
        Ok(SetupAccountResult {
            device_id,
            recovery_phrase,
        }) => Ok(SetupResultView {
            success: true,
            error: None,
            device_id: Some(device_id),
            email: Some(input.email),
            recovery_phrase: Some(vec![recovery_phrase]),
            needs_recovery_setup: Some(true),
        }),
        Err(err) => Ok(SetupResultView {
            success: false,
            error: Some(redact_err(&err)),
            device_id: None,
            email: None,
            recovery_phrase: None,
            needs_recovery_setup: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_setup_confirm_recovery_phrase(
    state: tauri::State<'_, AppState>,
    input: ConfirmRecoveryPhraseInput,
) -> AppResult<SimpleSuccess> {
    account::set_recovery_confirmed(&state, input.confirmed)?;
    Ok(SimpleSuccess {
        success: true,
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_setup_get_recovery_phrase(
    state: tauri::State<'_, AppState>,
) -> AppResult<RecoveryPhraseView> {
    let phrase = account::get_recovery_phrase(&state)?;
    Ok(RecoveryPhraseView { phrase })
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Returns a stable, IPC-safe error string. We intentionally keep the
/// `AppError` discriminant text and drop the inner details that may
/// contain server-issued bearer tokens or other sensitive fragments.
fn redact_err(err: &AppError) -> String {
    match err {
        AppError::Auth(_) => "auth error".into(),
        AppError::Network(_) => "network error".into(),
        AppError::Validation(_) => "validation error".into(),
        AppError::VaultLocked => "vault locked".into(),
        AppError::InvalidPassword => "invalid password".into(),
        AppError::Crypto(_) => "crypto error".into(),
        AppError::Database(_) => "database error".into(),
        AppError::Keychain(_) => "keychain error".into(),
        AppError::NotFound(_) => "not found".into(),
        AppError::RateLimited(_) => "rate limited".into(),
        AppError::Conflict(_) => "conflict".into(),
        AppError::Internal(_) => "internal error".into(),
        AppError::Vault(_) => "vault error".into(),
        AppError::PathEscape(_) => "path escape".into(),
        AppError::Io(_) => "io error".into(),
    }
}
