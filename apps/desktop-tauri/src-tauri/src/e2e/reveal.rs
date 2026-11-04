//! "Show in folder" and "open in the OS" under test. A spec cannot watch a file manager open, and a headless Linux
//! runner has none, so with an open gate `vault_reveal` records the path here instead of
//! launching one. `e2e_revealed_paths` reads it back. A link or file handed to the OS (a web link,
//! a `memry-file` file) is recorded the same way and `e2e_os_opens` reads it back, so a spec can
//! tell a navigation that left for the browser from one that stayed in the app.

use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, Runtime};

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

#[derive(Default)]
pub struct OsOpenLog(Mutex<Vec<String>>);

/// Sent to the page with each recorded open. On Linux a command the page sends while a main-frame
/// navigation it started is loading is refused (`shell::navigation_guard::linux`), so a spec that
/// navigated waits for the open here, without a command, and reads `e2e_os_opens` after it.
const OS_OPEN_EVENT: &str = "e2e-os-open";

/// `true` when the call was recorded (an open gate), so the caller skips the OS.
pub fn record_os_open<R: Runtime>(app: &AppHandle<R>, what: &str) -> bool {
    let Some(log) = app.try_state::<OsOpenLog>() else {
        return false;
    };
    log.0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(what.to_owned());
    if let Err(error) = app.emit(OS_OPEN_EVENT, what) {
        tracing::warn!(scope = "E2e", "the os open event was not sent: {error}");
    }
    true
}

/// What the app handed to the OS, as `url <url>`, `path <path>` (opened in its app) or
/// `reveal <path>` (shown in the file manager instead).
#[tauri::command]
pub fn e2e_os_opens<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, CommandError> {
    let log = app.try_state::<OsOpenLog>().ok_or_else(super::disabled)?;
    Ok(log.0.lock().unwrap_or_else(PoisonError::into_inner).clone())
}
