use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::startup::{self, StartupState};

pub const MAIN_LABEL: &str = "main";

/// Builds the main window. Chrome, bounds, vibrancy and the title bar belong to Step 10
/// (#3527). The webview profile lives under the instance's data dir, so two instances never
/// share localStorage.
pub fn create_main<R: Runtime>(
    app: &AppHandle<R>,
    state: &StartupState,
) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("MemryNote")
        .inner_size(1280.0, 800.0)
        // Fixes the Windows origin to https://tauri.localhost for good; macOS and Linux keep
        // tauri://localhost.
        .use_https_scheme(true)
        // OS file drops arrive as DOM `File` objects.
        .disable_drag_drop_handler()
        .initialization_script(startup::script(state));
    isolate_webview_profile(builder, &app.state::<AppPaths>()).build()
}

#[cfg(any(windows, target_os = "linux"))]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.data_directory(paths.webview_dir())
}

// macOS 14 and later. Earlier systems ignore the identifier and share one store, which is why
// the e2e harness refuses to start two instances on macOS 13.
#[cfg(target_os = "macos")]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.data_store_identifier(paths.webview_store_id())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    _paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}
