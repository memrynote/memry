//! Read-only SQL over the open vault's core databases, for specs and for
//! `scripts/agent-app.mjs query` and `index-query`. The rules are
//! `memry_desktop::e2e::debug`.

use memry_desktop::e2e::debug::{DebugQueryError, run_on_data, run_on_index};
use memry_desktop::session::Session;
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

fn failure(error: DebugQueryError) -> CommandError {
    match error {
        DebugQueryError::ReadOnly(_) => {
            CommandError::new(ErrorKind::Invalid, "read_only", error.to_string())
        }
        DebugQueryError::Storage(inner) => CommandError::from_core(&inner),
    }
}

fn query<R: Runtime>(
    app: &AppHandle<R>,
    sql: &str,
    run: fn(
        &memry_desktop::session::OpenVault,
        &str,
    ) -> Result<Vec<serde_json::Value>, DebugQueryError>,
) -> Result<Vec<serde_json::Value>, CommandError> {
    let session = app
        .try_state::<Session>()
        .ok_or_else(|| CommandError::new(ErrorKind::Locked, "no_session", "no vault session"))?;
    let open = session
        .current()
        .ok_or_else(|| CommandError::new(ErrorKind::Locked, "no_vault", "no vault is open"))?;
    run(&open, sql).map_err(failure)
}

/// One read statement against `data.db`; rows are JSON objects, at most 1000.
#[tauri::command]
pub async fn e2e_debug_query<R: Runtime>(
    app: AppHandle<R>,
    sql: String,
) -> Result<Vec<serde_json::Value>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || query(&app, &sql, run_on_data))
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "task_failed", error.to_string()))?
}

/// The same against `index.db`.
#[tauri::command]
pub async fn e2e_debug_index_query<R: Runtime>(
    app: AppHandle<R>,
    sql: String,
) -> Result<Vec<serde_json::Value>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || query(&app, &sql, run_on_index))
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "task_failed", error.to_string()))?
}
