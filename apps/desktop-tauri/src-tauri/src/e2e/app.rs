use memry_desktop::e2e::control;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::error::{CommandError, ErrorKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eAppInfo {
    pub pid: u32,
    pub app_data_dir: String,
    pub log_dir: String,
    pub device: String,
    pub version: String,
    pub build_kind: &'static str,
    pub webdriver_port: u16,
}

/// What the harness compares with the control file it wrote.
#[tauri::command]
pub fn e2e_app_info<R: Runtime>(app: AppHandle<R>) -> Result<E2eAppInfo, CommandError> {
    let paths = app.state::<AppPaths>();
    let env = app.state::<LaunchEnv>();
    Ok(E2eAppInfo {
        pid: std::process::id(),
        app_data_dir: paths.data_dir.to_string_lossy().into_owned(),
        log_dir: paths.log_dir.to_string_lossy().into_owned(),
        device: env.get(DEVICE_VAR).unwrap_or_default().to_owned(),
        version: app.package_info().version.to_string(),
        build_kind: "e2e",
        webdriver_port: control::webdriver_port(&env),
    })
}

/// Quits the app. The exit can beat the reply to the driver, so specs send it with `sendTest`.
#[tauri::command]
pub fn e2e_request_quit<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/// Set by [`e2e_quit_on_page_start`], taken by the next page start of the main window.
static QUIT_ON_PAGE_START: AtomicBool = AtomicBool::new(false);

/// Quits the app the moment the main window's next document commits, before its scripts run: a
/// quit while the page loads, as at a launch or a reload, with no timing left to chance.
#[tauri::command]
pub fn e2e_quit_on_page_start() {
    QUIT_ON_PAGE_START.store(true, Ordering::SeqCst);
}

/// Watches page starts for [`e2e_quit_on_page_start`]. The exit is posted to the event loop, so
/// the app's own page-start handlers run first.
pub fn quit_on_page_start_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("memry-e2e-quit-on-page-start")
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started)
                && webview.label() == "main"
                && QUIT_ON_PAGE_START.swap(false, Ordering::SeqCst)
            {
                tracing::info!(scope = "e2e", "quitting as the main page starts");
                webview.app_handle().exit(0);
            }
        })
        .build()
}

/// Emits a Tauri event to every window; the replacement for `webContents.send` in specs.
#[tauri::command]
pub fn e2e_emit<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    payload: Option<serde_json::Value>,
) -> Result<(), CommandError> {
    app.emit(&event, payload.unwrap_or(serde_json::Value::Null))
        .map_err(|error| CommandError::new(ErrorKind::Invalid, "e2e_emit", error.to_string()))
}
