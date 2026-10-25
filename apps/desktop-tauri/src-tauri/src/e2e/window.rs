use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

const MAIN_THREAD_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eWindow {
    pub label: String,
    pub visible: bool,
    pub focused: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub title: String,
}

fn failure(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Internal, "e2e_window", error.to_string())
}

/// Position and inner size in logical pixels.
#[tauri::command]
pub fn e2e_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<E2eWindow>, CommandError> {
    let mut windows = Vec::new();
    for (label, window) in app.webview_windows() {
        let scale = window.scale_factor().map_err(failure)?;
        let position = window
            .outer_position()
            .map_err(failure)?
            .to_logical::<f64>(scale);
        let size = window
            .inner_size()
            .map_err(failure)?
            .to_logical::<f64>(scale);
        windows.push(E2eWindow {
            visible: window.is_visible().map_err(failure)?,
            focused: window.is_focused().map_err(failure)?,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            title: window.title().map_err(failure)?,
            label,
        });
    }
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(windows)
}

/// Restores the window, then moves it and sets its inner size, both in logical pixels, on the
/// main thread.
#[tauri::command]
pub async fn e2e_set_window_rect<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    let window = app.get_webview_window(&label).ok_or_else(|| {
        CommandError::new(
            ErrorKind::NotFound,
            "e2e_window",
            format!("no window {label}"),
        )
    })?;
    let (done, result) = mpsc::channel();
    app.run_on_main_thread(move || {
        // A window manager that maximizes a window larger than the screen (XFCE on a small
        // display) ignores `set_size` until the window is restored.
        let applied = window
            .unmaximize()
            .and_then(|()| window.set_size(LogicalSize::new(width, height)))
            .and_then(|()| window.set_position(LogicalPosition::new(x, y)));
        // The receiver outlives the call unless it timed out, in which case nobody reads it.
        let _ = done.send(applied.map_err(|error| error.to_string()));
    })
    .map_err(failure)?;
    tauri::async_runtime::spawn_blocking(move || result.recv_timeout(MAIN_THREAD_WAIT))
        .await
        .map_err(failure)?
        .map_err(failure)?
        .map_err(failure)
}
