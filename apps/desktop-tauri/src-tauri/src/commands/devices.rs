//! The account's devices (`ipc/auth-device-handlers.ts:515-641`): the list, a rename and a
//! removal. Each command calls one `AccountService` method; the renderer wraps a failure into
//! Electron's `{ success, error }` envelope (`services/device-service.ts`).

use std::sync::Arc;

use memry_desktop::account::{AccountError, AccountService, DeviceFormFactor};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, log_failure};

/// Chapter 02 §2.3.4: `None` is unknown and the device list falls back to `platform`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FormFactor {
    Phone,
    Tablet,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub form_factor: Option<FormFactor>,
    pub is_current_device: bool,
    /// Epoch milliseconds.
    pub last_sync_at: Option<i64>,
    /// Epoch milliseconds; 0 when the server sent no `createdAt`.
    pub linked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListView {
    pub devices: Vec<DeviceView>,
    pub email: Option<String>,
    pub needs_recovery_confirmation: bool,
}

fn account(app: &AppHandle<Wry>) -> Arc<AccountService> {
    app.state::<Arc<AccountService>>().inner().clone()
}

/// The core mapping, with Electron's sentence for removing this device.
fn map_error(app: &AppHandle<Wry>, command: &str, error: &AccountError) -> CommandError {
    let mut mapped = CommandError::from_core(error);
    if matches!(error, AccountError::CannotRemoveCurrentDevice) {
        let locale = app.state::<Arc<LocaleService>>().get();
        mapped.message = i18n::t(
            locale,
            "errors:auth.cannotRemoveCurrentDevice",
            &Args::new(),
        );
    }
    log_failure(command, &mapped);
    mapped
}

/// The server stores seconds; the renderer formats milliseconds (`toTimestampMs`).
fn millis(seconds: i64) -> i64 {
    seconds.saturating_mul(1000)
}

/// `sync:get-devices`. Empty when this install registered no device or the server did not answer.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_devices(app: AppHandle<Wry>) -> Result<DeviceListView, CommandError> {
    let list = account(&app).devices().await;
    Ok(DeviceListView {
        devices: list
            .devices
            .into_iter()
            .map(|device| DeviceView {
                id: device.id,
                name: device.name,
                platform: device.platform,
                form_factor: device.form_factor.map(|form| match form {
                    DeviceFormFactor::Phone => FormFactor::Phone,
                    DeviceFormFactor::Tablet => FormFactor::Tablet,
                }),
                is_current_device: device.is_current,
                last_sync_at: device.last_sync_at.map(millis),
                linked_at: device.created_at.map_or(0, millis),
            })
            .collect(),
        email: list.email,
        needs_recovery_confirmation: list.needs_recovery_confirmation,
    })
}

/// `sync:rename-device`.
#[tauri::command]
#[specta::specta]
pub async fn sync_rename_device(
    app: AppHandle<Wry>,
    device_id: String,
    new_name: String,
) -> Result<(), CommandError> {
    account(&app)
        .rename_device(device_id, new_name)
        .await
        .map_err(|e| map_error(&app, "sync_rename_device", &e))
}

/// `sync:remove-device`: never this device.
#[tauri::command]
#[specta::specta]
pub async fn sync_remove_device(
    app: AppHandle<Wry>,
    device_id: String,
) -> Result<(), CommandError> {
    account(&app)
        .remove_device(device_id)
        .await
        .map_err(|e| map_error(&app, "sync_remove_device", &e))
}
