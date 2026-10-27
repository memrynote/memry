//! Settings commands: every group and flat key of the open vault, read and written through
//! `memry_desktop::settings`. The commands are generic over the group on purpose: the renderer
//! already has the typed shapes (`@memry/contracts/settings-schemas`) and `lib/settings-api.ts`
//! gives each function its old name; the rules (types, ranges, which fields sync) live in core.

use std::sync::Arc;

use memry_desktop::registry::AppConfig;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::settings::{SettingsError, SettingsService};
use memry_desktop::startup_values;
use memry_desktop::telemetry::lifecycle::setting_changed;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{SettingsChangedEvent, broadcast};
use crate::shell::services::telemetry;

fn current(app: &AppHandle<Wry>) -> Option<OpenVault> {
    app.state::<Session>().current()
}

fn service(app: &AppHandle<Wry>) -> SettingsService {
    app.state::<SettingsService>().inner().clone()
}

fn map_error(error: SettingsError) -> CommandError {
    match error {
        SettingsError::NoVault => {
            CommandError::new(ErrorKind::NotFound, "no_vault_open", "No vault is open")
        }
        SettingsError::Invalid(message) => {
            CommandError::new(ErrorKind::Invalid, "settings_invalid_value", message)
        }
        SettingsError::Failed(message) => {
            CommandError::new(ErrorKind::Storage, "settings_failed", message)
        }
    }
}

fn patch_of(value: Value) -> Result<Map<String, Value>, CommandError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(CommandError::new(
            ErrorKind::Invalid,
            "settings_invalid_value",
            "a settings patch is an object",
        )),
    }
}

/// Tells every window and telemetry what was written: names only.
fn announce(app: &AppHandle<Wry>, key: &str, fields: Vec<String>) {
    if let Some(service) = telemetry(app) {
        if fields.is_empty() {
            setting_changed(&service, key);
        }
        for field in &fields {
            setting_changed(&service, &format!("{key}.{field}"));
        }
    }
    broadcast(
        app,
        SettingsChangedEvent {
            key: key.to_owned(),
            fields,
        },
    );
    if key == "keyboard" {
        crate::menu::apply(app, false);
    }
}

/// A group of the open vault, or its defaults while no vault is open.
#[tauri::command]
#[specta::specta]
pub async fn settings_get_group(app: AppHandle<Wry>, group: String) -> Result<Value, CommandError> {
    let (service, vault) = (service(&app), current(&app));
    blocking("settings_get_group", move || {
        let read = service.read_group(vault.as_ref(), &group).map_err(map_error)?;
        if read.corrupt_reset {
            tracing::warn!(scope = "Settings", error_code = %format!("settings_group_corrupted_{group}"), "settings group `{group}` was unreadable and was reset to its defaults");
        }
        Ok(Value::Object(read.value))
    })
    .await
}

/// Merges `patch` into a group. A value the group refuses rejects with `settings_invalid_value`
/// and nothing is written.
#[tauri::command]
#[specta::specta]
pub async fn settings_set_group(
    app: AppHandle<Wry>,
    group: String,
    patch: Value,
) -> Result<(), CommandError> {
    let (service, vault) = (service(&app), current(&app));
    let change = blocking("settings_set_group", move || {
        service
            .write_group(vault.as_ref(), &group, patch_of(patch)?)
            .map_err(map_error)
    })
    .await?;
    announce(&app, &change.group, change.fields);
    Ok(())
}

/// One value by `<group>.<field>` or `<group>.<field>.<entry>`.
#[tauri::command]
#[specta::specta]
pub async fn settings_get_path(
    app: AppHandle<Wry>,
    path: String,
) -> Result<Option<Value>, CommandError> {
    let (service, vault) = (service(&app), current(&app));
    blocking("settings_get_path", move || {
        let Some(vault) = vault else { return Ok(None) };
        service.get_path(&vault, &path).map_err(map_error)
    })
    .await
}

/// A flat device-local key (`tagSearches`, `graphViews`).
#[tauri::command]
#[specta::specta]
pub async fn settings_get_local(
    app: AppHandle<Wry>,
    key: String,
) -> Result<Option<Value>, CommandError> {
    let (service, vault) = (service(&app), current(&app));
    blocking("settings_get_local", move || {
        service.get_local(vault.as_ref(), &key).map_err(map_error)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set_local(
    app: AppHandle<Wry>,
    key: String,
    value: Value,
) -> Result<(), CommandError> {
    let (service, vault) = (service(&app), current(&app));
    let change = blocking("settings_set_local", move || {
        service
            .set_local(vault.as_ref(), &key, &value)
            .map_err(map_error)
    })
    .await?;
    announce(&app, &change.group, change.fields);
    Ok(())
}

/// Restores the shortcut defaults. The folder shortcuts are entries the user added, not
/// departures from a default, so they stay.
#[tauri::command]
#[specta::specta]
pub async fn settings_reset_keyboard(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let (service, vault) = (service(&app), current(&app));
    let change = blocking("settings_reset_keyboard", move || {
        let kept = service
            .read_group(vault.as_ref(), "keyboard")
            .map_err(map_error)?
            .value
            .get("folderNoteShortcuts")
            .cloned();
        let mut defaults = service
            .read_group(None, "keyboard")
            .map_err(map_error)?
            .value;
        if let Some(kept) = kept {
            defaults.insert("folderNoteShortcuts".to_owned(), kept);
        }
        service
            .write_group(vault.as_ref(), "keyboard", defaults)
            .map_err(map_error)
    })
    .await?;
    announce(&app, &change.group, change.fields);
    Ok(())
}

/// Stores the zoom factor for the next launch's first paint (`startupValues`).
#[tauri::command]
#[specta::specta]
pub async fn app_set_zoom_factor(app: AppHandle<Wry>, factor: f64) -> Result<(), CommandError> {
    let config: Arc<AppConfig> = app.state::<Arc<AppConfig>>().inner().clone();
    let clamped = blocking("app_set_zoom_factor", move || {
        startup_values::set_zoom(&config, &Value::from(factor))
            .map_err(|e| CommandError::new(ErrorKind::Storage, "config_write", e.to_string()))
    })
    .await?;
    crate::windows::zoom::apply(&app, clamped);
    Ok(())
}
