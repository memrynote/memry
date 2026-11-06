//! The note fold commands of Step 14h (`note-fold:get` and `note-fold:last-run` of
//! `ipc/note-fold-handlers.ts`, the local levels), each one call of
//! `memry_desktop::fold::service::FoldService`, which `vault_boot` manages and starts with
//! every vault open.

use std::sync::Arc;

use memry_desktop::fold::service::{FoldRunState, FoldService};
use memry_desktop::fold::{FoldLayers, FoldLevel};
use memry_desktop::notes::error::NotesError;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, log_failure};

fn service<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<FoldService>, CommandError> {
    app.try_state::<Arc<FoldService>>()
        .map(|service| service.inner().clone())
        .ok_or_else(|| CommandError::from_core(&NotesError::Closed))
}

/// The note or journal day folded for a reader who asked for `level`.
#[tauri::command]
#[specta::specta]
pub async fn fold_run<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    level: FoldLevel,
) -> Result<FoldLayers, CommandError> {
    blocking("fold_run", move || {
        service(&app)?
            .run(&note_id, level)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The most recent run of this vault session, `null` before the first.
#[tauri::command]
#[specta::specta]
pub fn fold_get_last_run<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<FoldRunState>, CommandError> {
    service(&app)
        .map(|service| service.last_run())
        .inspect_err(|error| log_failure("fold_get_last_run", error))
}
