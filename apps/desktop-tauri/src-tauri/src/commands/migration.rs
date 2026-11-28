//! The first-launch migration (`crate::migration`). The `preboot` window's migration view calls
//! `migration_status`, `migration_retry` and `migration_open_report`, and no other window may
//! (`registry::window_allows`). The main window's init script calls
//! `migration_localstorage_applied` once it has set the Electron app's localStorage keys.

use std::sync::Arc;

use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::migration::Migration;
use crate::migration::local_storage;
use crate::migration::status::{self, MigrationStatus};

fn migration<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Migration>> {
    app.try_state::<Arc<Migration>>()
        .map(|migration| migration.inner().clone())
}

/// What the migration view shows now; `idle` on a launch that migrates nothing.
#[tauri::command]
#[specta::specta]
pub fn migration_status<R: Runtime>(app: AppHandle<R>) -> MigrationStatus {
    migration(&app).map_or_else(status::idle, |migration| migration.status())
}

/// Try again: runs the import again after a failure. Refused while a run is going, after it
/// succeeded, and on a launch without one.
#[tauri::command]
#[specta::specta]
pub fn migration_retry<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    if migration(&app).is_some_and(|migration| migration.start()) {
        return Ok(());
    }
    Err(CommandError::new(
        ErrorKind::Invalid,
        "migration_not_failed",
        "only a failed migration can run again",
    ))
}

/// Show details: shows the verification report (`electron-import-report.json`) in the file
/// manager.
#[tauri::command]
#[specta::specta]
pub fn migration_open_report<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    let report = migration(&app)
        .map(|migration| migration.report().to_path_buf())
        .filter(|report| report.is_file())
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotFound,
                "migration_report_missing",
                "no migration report yet",
            )
        })?;
    crate::shell::external::reveal(&app, &report)
}

/// Marks `electron-localstorage.json` applied, so no later window sets its keys again.
#[tauri::command]
#[specta::specta]
pub async fn migration_localstorage_applied<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), CommandError> {
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    blocking("migration_localstorage_applied", move || {
        local_storage::mark_applied(&data_dir)
            .map(|_| ())
            .map_err(|error| {
                CommandError::new(ErrorKind::Storage, "localstorage_write", error.to_string())
            })
    })
    .await
}
