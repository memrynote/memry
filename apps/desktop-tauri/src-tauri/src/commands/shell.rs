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

/// True once after the shell reloaded the calling page because its web process died, so the page
/// tells the user that recent edits may be lost.
#[tauri::command]
#[specta::specta]
pub fn shell_take_crash_reload(window: WebviewWindow<Wry>) -> Result<bool, CommandError> {
    Ok(crate::guards::process_gone::take_reloaded(window.label()))
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
        use crate::windows::win32_caption::set_rects;
        use memry_desktop::shell::caption::physical_rect;
        let rect = |r: CaptionRect| Some(physical_rect(r.x, r.y, r.width, r.height));
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

/// Shows a native context menu at the pointer and returns the clicked item id, or `None` when
/// the menu closed without a choice.
#[tauri::command]
#[specta::specta]
pub async fn shell_show_context_menu(
    app: AppHandle<Wry>,
    window: WebviewWindow<Wry>,
    items: Vec<crate::menu::popup::ContextMenuItem>,
) -> Result<Option<String>, CommandError> {
    crate::menu::popup::show(app, window, items).await
}

/// Alt pressed and released alone (the renderer tells a bare Alt from an Alt chord). Linux
/// shows or hides the menu bar, Windows pops the menu up. Returns whether a menu bar shows.
#[tauri::command]
#[specta::specta]
pub fn menu_toggle_alt(app: AppHandle<Wry>) -> Result<bool, CommandError> {
    Ok(crate::menu::toggle_alt(&app))
}

/// Escape pressed while the Linux menu bar shows.
#[tauri::command]
#[specta::specta]
pub fn menu_hide_alt(app: AppHandle<Wry>) -> Result<(), CommandError> {
    crate::menu::hide_bar(&app);
    Ok(())
}

/// Opens an `https:`, `http:` or `mailto:` link in the OS.
#[tauri::command]
#[specta::specta]
pub fn shell_open_external(app: AppHandle<Wry>, url: String) -> Result<(), CommandError> {
    crate::shell::external::open_url(&app, &url)
}

/// Follows a link activation the renderer kept from navigating the window: what the main frame's
/// navigation would have done with it (`shell::navigation_guard::open_link`).
#[tauri::command]
#[specta::specta]
pub fn shell_open_link(app: AppHandle<Wry>, url: String) -> Result<(), CommandError> {
    crate::shell::navigation_guard::open_link(&app, &url)
}

/// Opens a file of the open vault or the app data directory in the OS.
#[tauri::command]
#[specta::specta]
pub fn shell_open_path(app: AppHandle<Wry>, path: String) -> Result<(), CommandError> {
    crate::shell::external::open_path(&app, &path)
}

/// Shows a file of the open vault or the app data directory in the file manager.
#[tauri::command]
#[specta::specta]
pub fn shell_reveal_path(app: AppHandle<Wry>, path: String) -> Result<(), CommandError> {
    crate::shell::external::reveal_path(&app, &path)
}
