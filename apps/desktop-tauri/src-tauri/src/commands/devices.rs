//! Device-management command surface (sync_devices_*).
//!
//! All three commands talk to the auth server `/devices` endpoints. The
//! access token is sourced from the keychain under
//! `SERVICE_VAULT/access-token`; commands fail with `AppError::Auth` if
//! no session is present.

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::auth::account::KEYCHAIN_ACCESS_TOKEN;
use crate::db::sync_devices::SyncDevice;
use crate::error::{AppError, AppResult};
use crate::keychain::SERVICE_VAULT;
use crate::sync::auth_client;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevicesRemoveDeviceInput {
    pub device_id: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevicesRenameDeviceInput {
    pub device_id: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevicesGetDevicesResult {
    pub devices: Vec<DeviceView>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    pub linked_at: i64,
    pub last_sync_at: Option<i64>,
    pub is_current_device: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevicesMutationResult {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameBody<'a> {
    name: &'a str,
}

/// Server payload shape for `GET /devices`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDevicesResponse {
    #[serde(default)]
    devices: Vec<ServerDevice>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDevice {
    id: String,
    name: String,
    platform: String,
    #[serde(default)]
    os_version: Option<String>,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    linked_at: i64,
    #[serde(default)]
    last_sync_at: Option<i64>,
    #[serde(default)]
    created_at: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn sync_devices_get_devices(
    state: tauri::State<'_, AppState>,
) -> AppResult<SyncDevicesGetDevicesResult> {
    let access_token = read_access_token(&state)?;
    let server: ServerDevicesResponse = auth_client::get_devices(&access_token).await?;

    let current_id = current_device_id(&state)?;
    let devices = server
        .devices
        .into_iter()
        .map(|d| {
            let is_current = current_id.as_deref() == Some(&d.id);
            DeviceView {
                id: d.id,
                name: d.name,
                platform: d.platform,
                os_version: d.os_version,
                app_version: d.app_version,
                linked_at: d.linked_at,
                last_sync_at: d.last_sync_at,
                is_current_device: is_current,
                created_at: d.created_at,
            }
        })
        .collect();

    Ok(SyncDevicesGetDevicesResult {
        devices,
        email: server.email,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_devices_remove_device(
    state: tauri::State<'_, AppState>,
    input: SyncDevicesRemoveDeviceInput,
) -> AppResult<SyncDevicesMutationResult> {
    let access_token = read_access_token(&state)?;
    let _: serde_json::Value =
        auth_client::remove_device(&input.device_id, &access_token).await?;
    Ok(SyncDevicesMutationResult {
        success: true,
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_devices_rename_device(
    state: tauri::State<'_, AppState>,
    input: SyncDevicesRenameDeviceInput,
) -> AppResult<SyncDevicesMutationResult> {
    let access_token = read_access_token(&state)?;
    let body = RenameBody {
        name: &input.new_name,
    };
    let _: serde_json::Value =
        auth_client::rename_device(&input.device_id, &body, &access_token).await?;
    Ok(SyncDevicesMutationResult {
        success: true,
        error: None,
    })
}

fn read_access_token(state: &AppState) -> AppResult<String> {
    let bytes = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN)?
        .ok_or_else(|| AppError::Auth("no access token in keychain".into()))?;
    String::from_utf8(bytes).map_err(|err| AppError::Auth(format!("access token utf-8: {err}")))
}

fn current_device_id(state: &AppState) -> AppResult<Option<String>> {
    let conn = state.db.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id FROM sync_devices WHERE is_current_device = 1 LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

// Suppress unused-warning until M5 binds local rows directly.
#[allow(dead_code)]
fn _retain_sync_device(_d: SyncDevice) {}
