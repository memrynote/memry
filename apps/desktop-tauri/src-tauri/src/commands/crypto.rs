//! Crypto command surface.
//!
//! Encrypt/decrypt always operate against the unlocked vault key kept
//! by `AuthRuntime`. Raw keys never cross the IPC boundary in either
//! direction. Inputs and outputs use base64 for binary fields so Specta
//! produces a clean string-typed surface without bespoke byte handling
//! on the renderer side.
//!
//! `crypto_rotate_keys` and `crypto_get_rotation_progress` exist so the
//! renderer's settings UI can render its rotation affordances; the M4
//! plan defers actual rotation to the M7 sync engine work, so these
//! return deterministic "not implemented" / "idle" payloads.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::crypto::primitives::{decrypt_blob, encrypt_blob};
use crate::crypto::sign_verify::verify_detached;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoEncryptItemInput {
    pub plaintext_b64: String,
    pub associated_data_b64: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoEncryptItemResult {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoDecryptItemInput {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
    pub associated_data_b64: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoDecryptItemResult {
    pub plaintext_b64: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoVerifySignatureInput {
    pub message_b64: String,
    pub signature_b64: String,
    pub public_key_b64: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoVerifySignatureResult {
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoRotateKeysResult {
    pub success: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CryptoRotationProgress {
    pub in_progress: bool,
    pub completed: u32,
    pub total: u32,
}

pub fn crypto_encrypt_item_inner(
    state: &AppState,
    input: CryptoEncryptItemInput,
) -> AppResult<CryptoEncryptItemResult> {
    let key = state.auth.vault_key_clone().ok_or(AppError::VaultLocked)?;
    let plaintext = decode_b64(&input.plaintext_b64, "plaintext")?;
    let aad = match input.associated_data_b64.as_deref() {
        Some(s) => Some(decode_b64(s, "associatedData")?),
        None => None,
    };
    let blob = encrypt_blob(&plaintext, &key, aad.as_deref())?;
    Ok(CryptoEncryptItemResult {
        ciphertext_b64: B64.encode(&blob.ciphertext),
        nonce_b64: B64.encode(blob.nonce),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn crypto_encrypt_item(
    state: tauri::State<'_, AppState>,
    input: CryptoEncryptItemInput,
) -> AppResult<CryptoEncryptItemResult> {
    crypto_encrypt_item_inner(&state, input)
}

pub fn crypto_decrypt_item_inner(
    state: &AppState,
    input: CryptoDecryptItemInput,
) -> AppResult<CryptoDecryptItemResult> {
    let key = state.auth.vault_key_clone().ok_or(AppError::VaultLocked)?;
    let ciphertext = decode_b64(&input.ciphertext_b64, "ciphertext")?;
    let nonce = decode_b64(&input.nonce_b64, "nonce")?;
    let aad = match input.associated_data_b64.as_deref() {
        Some(s) => Some(decode_b64(s, "associatedData")?),
        None => None,
    };
    let plaintext = decrypt_blob(&ciphertext, &nonce, &key, aad.as_deref())?;
    Ok(CryptoDecryptItemResult {
        plaintext_b64: B64.encode(plaintext),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn crypto_decrypt_item(
    state: tauri::State<'_, AppState>,
    input: CryptoDecryptItemInput,
) -> AppResult<CryptoDecryptItemResult> {
    crypto_decrypt_item_inner(&state, input)
}

pub fn crypto_verify_signature_inner(
    _state: &AppState,
    input: CryptoVerifySignatureInput,
) -> AppResult<CryptoVerifySignatureResult> {
    let message = decode_b64(&input.message_b64, "message")?;
    let signature = decode_b64(&input.signature_b64, "signature")?;
    let public_key = decode_b64(&input.public_key_b64, "publicKey")?;
    let valid = verify_detached(&message, &signature, &public_key).is_ok();
    Ok(CryptoVerifySignatureResult { valid })
}

#[tauri::command]
#[specta::specta]
pub async fn crypto_verify_signature(
    state: tauri::State<'_, AppState>,
    input: CryptoVerifySignatureInput,
) -> AppResult<CryptoVerifySignatureResult> {
    crypto_verify_signature_inner(&state, input)
}

pub fn crypto_rotate_keys_inner(_state: &AppState) -> AppResult<CryptoRotateKeysResult> {
    Ok(CryptoRotateKeysResult {
        success: false,
        reason: Some("not-implemented-in-m4".to_string()),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn crypto_rotate_keys(
    state: tauri::State<'_, AppState>,
) -> AppResult<CryptoRotateKeysResult> {
    crypto_rotate_keys_inner(&state)
}

pub fn crypto_get_rotation_progress_inner(_state: &AppState) -> AppResult<CryptoRotationProgress> {
    Ok(CryptoRotationProgress {
        in_progress: false,
        completed: 0,
        total: 0,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn crypto_get_rotation_progress(
    state: tauri::State<'_, AppState>,
) -> AppResult<CryptoRotationProgress> {
    crypto_get_rotation_progress_inner(&state)
}

fn decode_b64(input: &str, field: &str) -> AppResult<Vec<u8>> {
    B64.decode(input)
        .map_err(|err| AppError::Validation(format!("invalid base64 in {field}: {err}")))
}
