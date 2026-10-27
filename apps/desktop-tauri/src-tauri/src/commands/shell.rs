use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow, Wry};

use super::error::{CommandError, ErrorKind};
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

/// Minimizes the calling window.
#[tauri::command]
#[specta::specta]
pub fn window_minimize(window: WebviewWindow<Wry>) -> Result<(), CommandError> {
    window.minimize().map_err(window_error)
}

/// Maximizes the calling window, or restores it when it is maximized.
#[tauri::command]
#[specta::specta]
pub fn window_toggle_maximize(window: WebviewWindow<Wry>) -> Result<(), CommandError> {
    if window.is_maximized().map_err(window_error)? {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(window_error)
}

/// Closes the calling window. The `CloseRequested` handlers (flush, tray) decide what follows.
#[tauri::command]
#[specta::specta]
pub fn window_close(window: WebviewWindow<Wry>) -> Result<(), CommandError> {
    window.close().map_err(window_error)
}

/// A caption button's rectangle in client coordinates, physical pixels.
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The renderer's measured caption buttons, for native hit testing (Windows; a no-op
/// elsewhere).
#[tauri::command]
#[specta::specta]
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn window_set_caption_rects(
    app: AppHandle<Wry>,
    min: CaptionRect,
    max: CaptionRect,
    close: CaptionRect,
) -> Result<(), CommandError> {
    #[cfg(windows)]
    {
        use crate::windows::win32_caption::{set_rects, to_rect};
        let rect = |r: CaptionRect| Some(to_rect(r.x, r.y, r.width, r.height));
        set_rects(
            &app,
            memry_desktop::shell::caption::CaptionRects {
                minimize: rect(min),
                maximize: rect(max),
                close: rect(close),
            },
        );
    }
    Ok(())
}

fn window_error(error: tauri::Error) -> CommandError {
    CommandError::new(ErrorKind::Internal, "window", error.to_string())
}
