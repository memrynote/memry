use std::time::Duration;

use memry_desktop::e2e::control;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use serde::Serialize;
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

/// Exits 100 ms later, so the reply returns first.
#[tauri::command]
pub fn e2e_request_quit<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        app.exit(0);
    });
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
