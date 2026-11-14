//! The note fold commands (`ipc/note-fold-handlers.ts`): `note-fold:get`, `retry` and
//! `last-run`, one call each of `memry_desktop::fold::service::FoldService`, which `vault_boot`
//! manages and starts with every vault open; and `note-fold:agent-status`, one call of
//! `memry_desktop::fold::agent::FoldAgents`. The service sends `NoteFoldUpdatedEvent`.

use std::sync::Arc;

use memry_desktop::ai::features;
use memry_desktop::fold::agent::{FoldAgentStatus, FoldAgents};
use memry_desktop::fold::queue::FoldLastRun;
use memry_desktop::fold::service::FoldService;
use memry_desktop::fold::{FoldLayers, FoldLevel};
use memry_desktop::notes::error::NotesError;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, log_failure};
use super::settings::map_error;

/// The managed service; a failure is logged under `command`.
fn service<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
) -> Result<Arc<FoldService>, CommandError> {
    app.try_state::<Arc<FoldService>>()
        .map(|service| service.inner().clone())
        .ok_or_else(|| failed(command, &NotesError::Closed))
}

/// The note or journal day folded for a reader who asked for `level`, with the chunks no model
/// has written yet queued.
#[tauri::command]
#[specta::specta]
pub async fn fold_run<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    level: FoldLevel,
) -> Result<FoldLayers, CommandError> {
    service(&app, "fold_run")?
        .run(&note_id, level)
        .await
        .map_err(|error| failed("fold_run", &error))
}

/// `note-fold:retry`: runs the failed chunks of `note_id` (none: of the last failed note) again.
#[tauri::command]
#[specta::specta]
pub async fn fold_retry<R: Runtime>(
    app: AppHandle<R>,
    note_id: Option<String>,
) -> Result<Option<FoldLayers>, CommandError> {
    service(&app, "fold_retry")?
        .retry(note_id)
        .await
        .map_err(|error| failed("fold_retry", &error))
}

/// `note-fold:last-run`: the last model run, for the settings row.
#[tauri::command]
#[specta::specta]
pub async fn fold_get_last_run<R: Runtime>(app: AppHandle<R>) -> Result<FoldLastRun, CommandError> {
    Ok(service(&app, "fold_get_last_run")?.last_run())
}

fn failed(command: &str, error: &NotesError) -> CommandError {
    let error = CommandError::from_core(error);
    log_failure(command, &error);
    error
}

/// `note-fold:agent-status`: the detected agents, the vault's `ai.summarizeAgent` and the agent a
/// run would use.
#[tauri::command]
#[specta::specta]
pub async fn fold_get_agent_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<FoldAgentStatus, CommandError> {
    let settings = app.state::<SettingsService>().inner().clone();
    let vault = app.state::<Session>().current();
    let choice = blocking("fold_get_agent_status", move || {
        features::read(&settings, vault.as_ref())
            .map(|ai| ai.summarize_agent)
            .map_err(map_error)
    })
    .await?;
    let agents = app.state::<Arc<FoldAgents>>().inner().clone();
    Ok(agents.status(choice).await)
}
