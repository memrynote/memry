//! "Show in folder" under test. A spec cannot watch a file manager open, and a headless Linux
//! runner has none, so with an open gate `vault_reveal` records the path here instead of
//! launching one. `e2e_revealed_paths` reads it back.

use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager, Runtime};

use crate::commands::error::CommandError;

#[derive(Default)]
pub struct RevealLog(Mutex<Vec<String>>);

/// `true` when the call was recorded (an open gate), so the caller skips the file manager.
pub fn record<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    let Some(log) = app.try_state::<RevealLog>() else {
        return false;
    };
    log.0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(path.to_owned());
    true
}

#[tauri::command]
pub fn e2e_revealed_paths<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, CommandError> {
    let log = app.try_state::<RevealLog>().ok_or_else(super::disabled)?;
    Ok(log.0.lock().unwrap_or_else(PoisonError::into_inner).clone())
}
