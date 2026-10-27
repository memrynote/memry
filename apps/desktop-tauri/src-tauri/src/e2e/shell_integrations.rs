use std::sync::Arc;

use memry_desktop::shell::flush::FLUSH_WINDOW_TIMEOUT;
use memry_desktop::shell::shutdown::Deadline;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::flush::FlushService;
use crate::shutdown::ShutdownService;

fn invalid(code: &'static str, message: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Invalid, code, message.to_string())
}

/// Makes step `step` of the next quit never finish, so a spec can watch the overrun path: the
/// hard backstop, the marker stamp and the next launch's report.
#[tauri::command]
pub fn e2e_trigger_shutdown_overrun(app: AppHandle<Wry>, step: String) -> Result<(), CommandError> {
    app.state::<ShutdownService>()
        .register(&step, Arc::new(|_, _| Box::pin(std::future::pending())))
        .map_err(|error| invalid("e2e_shutdown_step", error))
}

/// Runs the real flush handshake against `label`: the event reaches the page and the page
/// answers with `flush_done`. False when it did not answer in time.
#[tauri::command]
pub async fn e2e_request_flush(app: AppHandle<Wry>, label: String) -> bool {
    app.state::<FlushService>()
        .request(&app, &label, Deadline::after(FLUSH_WINDOW_TIMEOUT))
        .await
}

/// Closes `label` the way its close button does, through `CloseRequested`.
#[tauri::command]
pub fn e2e_close_window(app: AppHandle<Wry>, label: String) -> Result<(), CommandError> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| invalid("e2e_window", format!("no window {label}")))?;
    window
        .close()
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string()))
}
