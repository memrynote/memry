use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::startup::{self, StartupState};

pub const MAIN_LABEL: &str = "main";

/// Builds the main window. Chrome, bounds, vibrancy and the title bar belong to Step 10
/// (#3527); the per-instance webview profile is Step 03 (#3520)'s edit of this builder.
pub fn create_main<R: Runtime>(
    app: &AppHandle<R>,
    state: &StartupState,
) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("MemryNote")
        .inner_size(1280.0, 800.0)
        // Fixes the Windows origin to https://tauri.localhost for good; macOS and Linux keep
        // tauri://localhost.
        .use_https_scheme(true)
        // OS file drops arrive as DOM `File` objects.
        .disable_drag_drop_handler()
        .initialization_script(startup::script(state))
        .build()
}
