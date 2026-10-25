//! The e2e build: the WDIO driver plugins, the `e2e_*` test commands and the dispatcher that
//! routes them. The whole module is `#[cfg(feature = "e2e")]`; the release build links none of
//! it. A second, run-time guard ([`E2eGate`], `MEMRY_E2E=1`) keeps an e2e binary inert unless
//! the harness started it.

mod app;
mod clipboard;
pub mod commands;
mod window;

use memry_desktop::e2e::E2eGate;
use memry_desktop::e2e::control::{self, ControlError};
use memry_desktop::launch_env::LaunchEnv;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Builder, Manager, Runtime, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::startup::{self, Stage};

/// Every test command starts with this prefix; the dispatcher routes on it.
pub const PREFIX: &str = "e2e_";

/// Overlays this instance's control file onto `env`. A no-op with a closed gate. `main` calls
/// it right after `LaunchEnv::from_process()`.
pub fn prepare_launch_env(env: &mut LaunchEnv) -> Result<(), ControlError> {
    if !E2eGate::from_env(env).is_open() {
        return Ok(());
    }
    control::load(env).map(|_| ())
}

/// Registers the driver plugins when the gate is open. The webdriver plugin reads
/// `TAURI_WEBDRIVER_PORT` itself.
pub fn install<R: Runtime>(builder: Builder<R>, gate: E2eGate) -> Builder<R> {
    if !gate.is_open() {
        return builder;
    }
    builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init())
}

pub fn disabled() -> CommandError {
    CommandError::new(
        ErrorKind::Invalid,
        "e2e_disabled",
        "test commands need MEMRY_E2E=1",
    )
}

/// Sends `e2e_*` calls to `e2e_handler` when the gate is open and rejects them with
/// `e2e_disabled` otherwise; every other call goes to `other`.
pub fn dispatcher<R: Runtime>(
    gate: E2eGate,
    e2e_handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    other: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !invoke.message.command().starts_with(PREFIX) {
            return other(invoke);
        }
        if gate.is_open() {
            return e2e_handler(invoke);
        }
        invoke.resolver.reject(disabled());
        true
    }
}

/// Registers the startup stage that records an open gate in `main.log`. The plugin's own line
/// is written before logging exists, so this one is what the no-driver smoke looks for.
pub fn register_stages() {
    startup::register(Stage::Plugins, "e2e driver", log_driver);
}

fn log_driver(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let env = app.state::<LaunchEnv>();
    if E2eGate::from_env(&env).is_open() {
        tracing::info!(
            "WDIO WebDriver plugin initialized on port {}",
            control::webdriver_port(&env)
        );
    }
    Ok(())
}
