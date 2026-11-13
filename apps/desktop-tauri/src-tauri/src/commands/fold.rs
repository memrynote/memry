//! The note fold commands (`ipc/note-fold-handlers.ts`): `note-fold:get` of Step 14h, the local
//! levels, one call of `memry_desktop::fold::service::FoldService`, which `vault_boot` manages
//! and starts with every vault open; and `note-fold:agent-status` (Step 22), one call of
//! `memry_desktop::fold::agent::FoldAgents`. Step 22 adds `note-fold:last-run` in Electron's
//! `FoldLastRun` shape.

use std::sync::Arc;

use memry_desktop::ai::features;
use memry_desktop::fold::agent::{FoldAgentStatus, FoldAgents};
use memry_desktop::fold::service::FoldService;
use memry_desktop::fold::{FoldLayers, FoldLevel};
use memry_desktop::notes::error::NotesError;
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::CommandError;
use super::settings::map_error;

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
