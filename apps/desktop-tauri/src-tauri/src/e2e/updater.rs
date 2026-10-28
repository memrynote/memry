//! The scripted update backend (`memry_desktop::updater::scripted`), present when the app runs
//! with `MEMRY_TEST_UPDATER=scripted`.

use std::sync::Arc;

use memry_desktop::updater::scripted::{ApplyCall, ScriptStep, ScriptedBackend};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

fn backend<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<ScriptedBackend>, CommandError> {
    app.try_state::<Arc<ScriptedBackend>>()
        .map(|backend| backend.inner().clone())
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::Invalid,
                "e2e_updater_not_scripted",
                "launch with MEMRY_TEST_UPDATER=scripted",
            )
        })
}

/// Replaces what the next feed checks find, one step per check.
#[tauri::command]
pub fn e2e_updater_script<R: Runtime>(
    app: AppHandle<R>,
    steps: Vec<ScriptStep>,
) -> Result<(), CommandError> {
    backend(&app)?.script(steps);
    Ok(())
}

/// Every install hand-off this profile saw, across launches, oldest first.
#[tauri::command]
pub fn e2e_updater_hook_calls<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ApplyCall>, CommandError> {
    Ok(backend(&app)?.applies())
}
