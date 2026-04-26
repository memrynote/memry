//! Account-level command surface: cached identity, sign-out, recovery
//! key.
//!
//! Each `#[tauri::command]` is a thin wrapper around a `*_inner`
//! function that takes `&AppState` so command behavior can be
//! exercised in unit tests without a Tauri runtime.

use serde::Serialize;

use crate::app_state::AppState;
use crate::auth::account;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfoView {
    pub user_id: String,
    pub email: String,
    pub auth_provider: String,
}

impl From<account::AccountInfo> for AccountInfoView {
    fn from(info: account::AccountInfo) -> Self {
        Self {
            user_id: info.user_id,
            email: info.email,
            auth_provider: info.auth_provider,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignOutResult {
    pub success: bool,
    pub error: Option<String>,
}

pub fn account_get_info_inner(state: &AppState) -> AppResult<Option<AccountInfoView>> {
    Ok(account::get_account_info(state)?.map(Into::into))
}

#[tauri::command]
#[specta::specta]
pub async fn account_get_info(
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<AccountInfoView>> {
    account_get_info_inner(&state)
}

pub fn account_sign_out_inner(state: &AppState) -> AppResult<AccountSignOutResult> {
    account::logout(state)?;
    Ok(AccountSignOutResult {
        success: true,
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn account_sign_out(
    state: tauri::State<'_, AppState>,
) -> AppResult<AccountSignOutResult> {
    account_sign_out_inner(&state)
}

pub fn account_get_recovery_key_inner(state: &AppState) -> AppResult<String> {
    account::get_recovery_phrase(state)
}

#[tauri::command]
#[specta::specta]
pub async fn account_get_recovery_key(state: tauri::State<'_, AppState>) -> AppResult<String> {
    account_get_recovery_key_inner(&state)
}
