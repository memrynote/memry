//! The in-app updater (`apps/desktop/src/main/ipc/updater-handlers.ts`). Every command answers
//! the state after it ran; the same state also reaches every window as
//! `UpdaterStateChangedEvent`.

use std::sync::Arc;

use memry_desktop::registry::ConfigError;
use memry_desktop::updater::health::VERSION_TOKEN;
use memry_desktop::updater::service::UpdaterService;
use memry_desktop::updater::severity::{UpdateError, UpdateErrorKind, error_code};
use memry_desktop::updater::state::AppUpdateState;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};

fn service(app: &AppHandle<Wry>) -> Arc<UpdaterService> {
    app.state::<Arc<UpdaterService>>().inner().clone()
}

/// A failed check or download, already logged, reported at its severity and shown in the state
/// by the service; the rejection only carries its text to the caller, so it skips
/// `log_failure`, which would report an offline check a second time and as an error.
fn update_failed(error: UpdateError) -> CommandError {
    let kind = match error.kind {
        UpdateErrorKind::Network(_) | UpdateErrorKind::Status(_) => ErrorKind::Transport,
        _ => ErrorKind::Internal,
    };
    let code = error_code(error.kind).unwrap_or_else(|| "update_failed".to_owned());
    CommandError::new(kind, &code, error.message)
}

fn config_failed(error: ConfigError) -> CommandError {
    CommandError::new(ErrorKind::Storage, "updater_prefs_write", error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn updater_get_state(app: AppHandle<Wry>) -> Result<AppUpdateState, CommandError> {
    Ok(service(&app).state())
}

/// A manual check: a skipped version may surface again.
#[tauri::command]
#[specta::specta]
pub async fn updater_check_for_updates(
    app: AppHandle<Wry>,
) -> Result<AppUpdateState, CommandError> {
    service(&app).check(true).await.map_err(update_failed)
}

#[tauri::command]
#[specta::specta]
pub async fn updater_download_update(app: AppHandle<Wry>) -> Result<AppUpdateState, CommandError> {
    service(&app).download().await.map_err(update_failed)
}

/// Restart to install: the state turns `installing`, then the quit runs and ends in the
/// installer (`UpdateApplyHook`).
#[tauri::command]
#[specta::specta]
pub async fn updater_quit_and_install(app: AppHandle<Wry>) -> Result<(), CommandError> {
    service(&app).request_install().map_err(|error| {
        CommandError::new(
            ErrorKind::Invalid,
            "update_not_downloaded",
            error.to_string(),
        )
    })?;
    app.exit(0);
    Ok(())
}

/// `version` is the display version the renderer shows (`v2026-11-01`).
#[tauri::command]
#[specta::specta]
pub async fn updater_skip_version(
    app: AppHandle<Wry>,
    version: String,
) -> Result<AppUpdateState, CommandError> {
    if !VERSION_TOKEN.is_match(&version) {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "updater_version_invalid",
            "not a version",
        ));
    }
    let service = service(&app);
    blocking("updater_skip_version", move || {
        service.skip_version(&version).map_err(config_failed)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn updater_set_auto_download(
    app: AppHandle<Wry>,
    enabled: bool,
) -> Result<AppUpdateState, CommandError> {
    let service = service(&app);
    blocking("updater_set_auto_download", move || {
        service.set_auto_download(enabled).map_err(config_failed)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn updater_set_auto_check(
    app: AppHandle<Wry>,
    enabled: bool,
) -> Result<AppUpdateState, CommandError> {
    let service = service(&app);
    blocking("updater_set_auto_check", move || {
        service.set_auto_check(enabled).map_err(config_failed)
    })
    .await
}
