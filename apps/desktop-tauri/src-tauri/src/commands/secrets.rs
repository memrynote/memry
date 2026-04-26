//! Provider key command surface.
//!
//! Raw provider keys never cross the IPC boundary in either direction
//! after `set_provider_key` returns. Only the masked `ProviderKeyStatus`
//! shape is serialised; reads return the same shape.

use serde::Deserialize;
use std::time::SystemTime;

use crate::app_state::AppState;
use crate::auth::secrets::{self, ProviderKeyStatus};
use crate::error::AppResult;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsSetProviderKeyInput {
    pub provider: String,
    pub raw_key: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetProviderKeyStatusInput {
    pub provider: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsDeleteProviderKeyInput {
    pub provider: String,
}

pub fn secrets_set_provider_key_inner(
    state: &AppState,
    input: SecretsSetProviderKeyInput,
) -> AppResult<ProviderKeyStatus> {
    let kc = state.auth.keychain();
    secrets::set_provider_key(
        kc.as_ref(),
        &input.provider,
        &input.raw_key,
        input.label,
        SystemTime::now(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_set_provider_key(
    state: tauri::State<'_, AppState>,
    input: SecretsSetProviderKeyInput,
) -> AppResult<ProviderKeyStatus> {
    secrets_set_provider_key_inner(&state, input)
}

pub fn secrets_get_provider_key_status_inner(
    state: &AppState,
    input: SecretsGetProviderKeyStatusInput,
) -> AppResult<ProviderKeyStatus> {
    let kc = state.auth.keychain();
    secrets::get_provider_key_status(kc.as_ref(), &input.provider)
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_get_provider_key_status(
    state: tauri::State<'_, AppState>,
    input: SecretsGetProviderKeyStatusInput,
) -> AppResult<ProviderKeyStatus> {
    secrets_get_provider_key_status_inner(&state, input)
}

pub fn secrets_delete_provider_key_inner(
    state: &AppState,
    input: SecretsDeleteProviderKeyInput,
) -> AppResult<()> {
    let kc = state.auth.keychain();
    secrets::delete_provider_key(kc.as_ref(), &input.provider)
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_delete_provider_key(
    state: tauri::State<'_, AppState>,
    input: SecretsDeleteProviderKeyInput,
) -> AppResult<()> {
    secrets_delete_provider_key_inner(&state, input)
}
