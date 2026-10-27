use tauri::{AppHandle, WebviewWindow, Wry};

use super::error::CommandError;
use crate::windows::reveal;

/// The renderer painted its first frame: reveals the main window once.
#[tauri::command]
#[specta::specta]
pub fn shell_first_paint(
    app: AppHandle<Wry>,
    window: WebviewWindow<Wry>,
) -> Result<(), CommandError> {
    reveal::first_paint(&app, &window);
    Ok(())
}

/// A liveness beat from the page, every 2 s.
#[tauri::command]
#[specta::specta]
pub fn shell_heartbeat(
    app: AppHandle<Wry>,
    window: WebviewWindow<Wry>,
) -> Result<(), CommandError> {
    reveal::heartbeat(&app, &window);
    Ok(())
}
