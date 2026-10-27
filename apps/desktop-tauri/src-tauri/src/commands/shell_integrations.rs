use tauri::{State, WebviewWindow, Wry};

use super::error::CommandError;
use crate::flush::FlushService;

/// The window finished the flush `request_id` asked for. Counts only from the window that was
/// asked, with the id that was issued.
#[tauri::command]
#[specta::specta]
pub fn flush_done(
    flush: State<'_, FlushService>,
    window: WebviewWindow<Wry>,
    request_id: String,
) -> Result<(), CommandError> {
    if !flush.done(window.label(), &request_id) {
        tracing::warn!(
            scope = "Shutdown",
            "ignored a flush reply from {} for an unknown request",
            window.label()
        );
    }
    Ok(())
}
