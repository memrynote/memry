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

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::auth::account::{self, LinkingDeviceMetadata, KEYCHAIN_ACCESS_TOKEN};
use crate::auth::linking::{self, ScanDeviceMetadata};
use crate::error::{AppError, AppResult};
use crate::keychain::SERVICE_VAULT;
use crate::sync::auth_client;

/// Sentinel error message returned by `complete_linking_with_base` when
/// the new device polls before the approver has acted. The renderer
/// `LinkingPending` component matches on this exact string to keep
/// polling rather than surfacing a terminal error to the user.
const LINKING_PENDING_SENTINEL: &str = "session not yet approved";

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingLinkViaQrInput {
    pub qr_json: String,
    pub device_name: String,
    pub device_platform: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingCompleteLinkingQrInput {
    pub session_id: String,
    /// Device metadata the renderer collected during the wizard.
    /// Required so this command can finish device registration via
    /// `/auth/devices` after the master key has been recovered.
    pub device_name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
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
    /// JSON-encoded `LinkingQrPayload` ready for the renderer to render
    /// inside a QR code or copy as text. The new device decodes this
    /// string when it calls `sync_linking_link_via_qr`.
    pub qr_payload: String,
    /// Unix-epoch seconds when the linking session expires server-side.
    /// The renderer uses this for the QR countdown.
    pub expires_at: i64,
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
    let access_token = read_access_token(&state)?;
    let base = crate::sync::http::resolve_base_url()?;
    let created =
        linking::generate_linking_qr_with_base(&base, &state.linking, &access_token).await?;
    let qr_payload = linking::encode_qr_payload(&created.payload)?;
    Ok(LinkingQrView {
        session_id: created.payload.session_id,
        qr_payload,
        expires_at: created.expires_at,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_link_via_qr(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingLinkViaQrInput,
) -> AppResult<LinkingScanView> {
    // The /auth/linking/scan endpoint is anonymous: the linking-secret
    // HMAC is what proves the new device scanned a real QR. We therefore
    // do NOT require a renderer-supplied access token here.
    let base = crate::sync::http::resolve_base_url()?;
    let metadata = ScanDeviceMetadata {
        device_name: input.device_name.clone(),
        device_platform: input.device_platform.clone(),
    };
    let scan =
        linking::link_via_qr_with_base(&base, &state.linking, &input.qr_json, &metadata).await?;
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
            // Hand the recovered master key off to `finalize_linking`,
            // which (mirroring Electron's `finalizeLinking`):
            //  - fetches `/auth/recovery-info` and persists kdfSalt +
            //    keyVerifier so password unlock works on this device,
            //  - registers this device via `/auth/devices` (consuming
            //    the setup token),
            //  - persists access/refresh tokens,
            //  - persists the master key under
            //    `SERVICE_VAULT/master-key` and unlocks the auth
            //    runtime so subsequent crypto commands work without
            //    another password prompt.
            //
            // Without this step the renderer would mark the user
            // authenticated while every device-scoped API call (and
            // `crypto_encrypt_item` / `crypto_decrypt_item`) failed.
            let metadata = LinkingDeviceMetadata {
                device_name: input.device_name,
                platform: input.platform,
                os_version: input.os_version,
                app_version: input.app_version,
            };
            match account::finalize_linking_with_base(&base, &state, result.master_key, metadata)
                .await
            {
                Ok(finalize) => Ok(LinkingCompleteView {
                    success: true,
                    error: None,
                    device_id: Some(finalize.device_id),
                }),
                Err(err) => Ok(LinkingCompleteView {
                    success: false,
                    error: Some(redact(&err)),
                    device_id: None,
                }),
            }
        }
        Err(err) => Ok(LinkingCompleteView {
            success: false,
            error: Some(redact_complete_linking(&err)),
            device_id: None,
        }),
    }
}

/// Like `redact()`, but preserves the `"session not yet approved"`
/// sentinel as-is so the renderer's polling loop in
/// `LinkingPending` can distinguish a normal pending state from a
/// terminal failure. Every other AppError variant is mapped through
/// the standard `redact()` helper.
fn redact_complete_linking(err: &AppError) -> String {
    if let AppError::Auth(msg) = err {
        if msg == LINKING_PENDING_SENTINEL {
            return LINKING_PENDING_SENTINEL.to_string();
        }
    }
    redact(err)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_link_via_recovery(
    _state: tauri::State<'_, AppState>,
    _input: SyncLinkingLinkViaRecoveryInput,
) -> AppResult<LinkingMutationResult> {
    Ok(LinkingMutationResult {
        success: false,
        error: Some("recovery-phrase device linking is deferred to post-M4".to_string()),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_approve_linking(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingApproveLinkingInput,
) -> AppResult<LinkingMutationResult> {
    let access_token = read_access_token(&state)?;
    let master_key = state.auth.master_key_clone().ok_or(AppError::VaultLocked)?;
    let initiator_session = state
        .linking
        .peek(&input.session_id)
        .ok_or_else(|| AppError::NotFound(format!("linking session: {}", input.session_id)))?;

    // Fetch the new device's public key + new-device-confirm from the
    // server (recorded by `/auth/linking/scan` on the new-device side).
    // The renderer never sees these values directly, so we cannot
    // accept them as input — that would let an attacker who controls
    // the renderer swap the public key and seal the master key for
    // themselves. `approve_linking_with_base` re-verifies the
    // newDeviceConfirm HMAC against the locally derived macKey before
    // sealing.
    let base = crate::sync::http::resolve_base_url()?;
    let session_info: ServerLinkingSession =
        auth_client::get_linking_session_with_base(&base, &input.session_id, &access_token).await?;
    let new_device_public_key = linking::decode_b64(&session_info.new_device_public_key)?;
    let new_device_confirm_b64 = session_info.new_device_confirm.ok_or_else(|| {
        AppError::Auth(
            "linking session is missing new-device-confirm; new device hasn't scanned yet".into(),
        )
    })?;

    match linking::approve_linking_with_base(
        &base,
        &input.session_id,
        &initiator_session.ephemeral_secret_key,
        &master_key,
        &new_device_public_key,
        &new_device_confirm_b64,
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

/// Subset of the `/auth/linking/session/:id` response we need on the
/// approver side. The server returns more fields (status, expiresAt)
/// but the approve flow only needs the new device's public key (to
/// derive the X25519 shared secret) and the new-device-confirm HMAC
/// (so the approver can verify the public key was actually signed by
/// the device that claims to have scanned the QR).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerLinkingSession {
    new_device_public_key: String,
    #[serde(default)]
    new_device_confirm: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn sync_linking_get_linking_sas(
    state: tauri::State<'_, AppState>,
    input: SyncLinkingGetLinkingSasInput,
) -> AppResult<LinkingSasView> {
    // The SAS must be derived from the X25519 shared secret (matches
    // Electron's `computeVerificationCode(sharedSecret)`). The approver
    // does not have the new device's public key locally, so fetch it
    // from the server, compute the shared secret with the locally
    // stored ephemeral secret key, and derive the six digits from the
    // result. We do NOT consume the registry entry here — the same
    // session is reused for the subsequent `approve_linking` call.
    let session = peek_session(&state, &input.session_id)?;
    let access_token = read_access_token(&state)?;
    let base = crate::sync::http::resolve_base_url()?;
    let session_info: ServerLinkingSession =
        auth_client::get_linking_session_with_base(&base, &input.session_id, &access_token).await?;
    let new_device_public_key = linking::decode_b64(&session_info.new_device_public_key)?;
    let shared_secret =
        linking::derive_shared_secret(&session.ephemeral_secret_key, &new_device_public_key)?;
    let sas_code = linking::generate_sas_code(&shared_secret)?;
    Ok(LinkingSasView { sas_code })
}

fn read_access_token(state: &AppState) -> AppResult<String> {
    let bytes = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN)?
        .ok_or_else(|| AppError::Auth("no access token in keychain".into()))?;
    String::from_utf8(bytes).map_err(|err| AppError::Auth(format!("access token utf-8: {err}")))
}

/// Reads a pending linking session WITHOUT consuming it.
fn peek_session(state: &AppState, session_id: &str) -> AppResult<linking::PendingLinkingSession> {
    state
        .linking
        .peek(session_id)
        .ok_or_else(|| AppError::NotFound(format!("linking session: {session_id}")))
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
