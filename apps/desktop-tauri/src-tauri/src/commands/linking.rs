//! Cross-device linking command surface (sync_linking_*).
//!
//! Master-key bytes never cross the IPC boundary. `complete_linking_qr`
//! decrypts the sealed master key inside Rust and persists it to the
//! keychain; the renderer only sees `{ deviceId }`.
//!
//! `link_via_recovery` is deferred: recovery-phrase based unlock without
//! an approver device is part of the post-M4 flow because it needs the
//! server `/auth/recovery-info` endpoint plus a server-issued setup
//! token rotation. The command is registered so the renderer surface
//! stays stable; it returns an explicit failure.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::auth::account::KEYCHAIN_ACCESS_TOKEN;
use crate::auth::linking::{self, LinkingQrPayload};
use crate::error::{AppError, AppResult};
use crate::keychain::SERVICE_VAULT;

const KEYCHAIN_SETUP_TOKEN: &str = "setup-token";
const KEYCHAIN_MASTER_KEY: &str = "master-key";

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingLinkViaQrInput {
    pub qr_json: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingCompleteLinkingQrInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingLinkViaRecoveryInput {
    pub recovery_phrase: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingApproveLinkingInput {
    pub session_id: String,
    pub new_device_public_key_b64: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingGetLinkingSasInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingQrView {
    pub session_id: String,
    pub linking_secret: String,
    pub ephemeral_public_key: String,
}

impl From<LinkingQrPayload> for LinkingQrView {
    fn from(p: LinkingQrPayload) -> Self {
        Self {
            session_id: p.session_id,
            linking_secret: p.linking_secret,
            ephemeral_public_key: p.ephemeral_public_key,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingScanView {
    pub session_id: String,
    pub sas_code: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingCompleteView {
    pub success: bool,
    pub error: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingMutationResult {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingSasView {
    pub sas_code: String,
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_generate_linking_qr(
    state: tauri::State<'_, AppState>,
) -> AppResult<LinkingQrView> {
    let setup_token = read_setup_token(&state)?;
    let base = crate::sync::http::resolve_base_url()?;
    let payload = linking::generate_linking_qr_with_base(&base, &state.linking, &setup_token).await?;
    Ok(payload.into())
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_link_via_qr(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingLinkViaQrInput,
) -> AppResult<LinkingScanView> {
    let access_token = read_access_token(&state)?;
    let base = crate::sync::http::resolve_base_url()?;
    let scan = linking::link_via_qr_with_base(&base, &input.qr_json, &access_token).await?;
    Ok(LinkingScanView {
        session_id: scan.session_id,
        sas_code: scan.sas_code,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_complete_linking_qr(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingCompleteLinkingQrInput,
) -> AppResult<LinkingCompleteView> {
    let base = crate::sync::http::resolve_base_url()?;
    match linking::complete_linking_with_base(&base, &state.linking, &input.session_id).await {
        Ok(result) => {
            // Persist the recovered master key under the canonical
            // keychain account; the renderer never sees the bytes.
            state.auth.keychain().set_item(
                SERVICE_VAULT,
                KEYCHAIN_MASTER_KEY,
                &result.master_key,
            )?;
            Ok(LinkingCompleteView {
                success: true,
                error: None,
                device_id: Some(result.device_id),
            })
        }
        Err(err) => Ok(LinkingCompleteView {
            success: false,
            error: Some(redact(&err)),
            device_id: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_link_via_recovery(
    _state: tauri::State<'_, AppState>,
    _input: SyncLinkingLinkViaRecoveryInput,
) -> AppResult<LinkingMutationResult> {
    Ok(LinkingMutationResult {
        success: false,
        error: Some(
            "recovery-phrase device linking is deferred to post-M4".to_string(),
        ),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_approve_linking(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingApproveLinkingInput,
) -> AppResult<LinkingMutationResult> {
    let access_token = read_access_token(&state)?;
    let master_key = state
        .auth
        .master_key_clone()
        .ok_or(AppError::VaultLocked)?;
    let new_device_public_key = B64
        .decode(&input.new_device_public_key_b64)
        .map_err(|err| {
            AppError::Validation(format!("invalid newDevicePublicKey base64: {err}"))
        })?;
    let base = crate::sync::http::resolve_base_url()?;
    match linking::approve_linking_with_base(
        &base,
        &input.session_id,
        &master_key,
        &new_device_public_key,
        &access_token,
    )
    .await
    {
        Ok(()) => Ok(LinkingMutationResult {
            success: true,
            error: None,
        }),
        Err(err) => Ok(LinkingMutationResult {
            success: false,
            error: Some(redact(&err)),
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_get_linking_sas(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingGetLinkingSasInput,
) -> AppResult<LinkingSasView> {
    // Look up the local pending session; the SAS is computed from the
    // QR-side `linking_secret` so both ends derive the same six digits.
    // We do NOT consume the registry entry here — `complete_linking_qr`
    // is the only consumer.
    let session = peek_session(&state, &input.session_id)?;
    let sas_code = linking::generate_sas_code(&session.linking_secret)?;
    Ok(LinkingSasView { sas_code })
}

fn read_setup_token(state: &AppState) -> AppResult<String> {
    let bytes = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?
        .ok_or_else(|| AppError::Auth("no setup token in keychain".into()))?;
    String::from_utf8(bytes).map_err(|err| AppError::Auth(format!("setup token utf-8: {err}")))
}

fn read_access_token(state: &AppState) -> AppResult<String> {
    let bytes = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN)?
        .ok_or_else(|| AppError::Auth("no access token in keychain".into()))?;
    String::from_utf8(bytes).map_err(|err| AppError::Auth(format!("access token utf-8: {err}")))
}

/// Peeks at a pending linking session WITHOUT consuming it. The
/// `PendingLinkingRegistry` only exposes `take`, so we re-insert after
/// reading. This is a stop-gap until the registry grows a `peek` API.
fn peek_session(
    state: &AppState,
    session_id: &str,
) -> AppResult<linking::PendingLinkingSession> {
    let session = state
        .linking
        .take(session_id)
        .ok_or_else(|| AppError::NotFound(format!("linking session: {session_id}")))?;
    state.linking.insert(session.clone());
    Ok(session)
}

fn redact(err: &AppError) -> String {
    match err {
        AppError::Auth(_) => "auth error".into(),
        AppError::Network(_) => "network error".into(),
        AppError::Validation(_) => "validation error".into(),
        AppError::Crypto(_) => "crypto error".into(),
        AppError::NotFound(_) => "not found".into(),
        AppError::RateLimited(_) => "rate limited".into(),
        _ => "internal error".into(),
    }
}
