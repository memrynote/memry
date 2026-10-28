//! The e2e build: the WDIO driver plugins, the `e2e_*` test commands and the dispatcher that
//! routes them. The whole module is `#[cfg(feature = "e2e")]`; the release build links none of
//! it. A second, run-time guard ([`E2eGate`], `MEMRY_E2E=1`) keeps an e2e binary inert unless
//! the harness started it.

mod app;
mod clipboard;
pub mod commands;
mod crash;
mod debug;
mod dialog;
mod reveal;
mod shell;
mod shell_integrations;
mod updater;
pub mod vault_writeback;
mod window;

use memry_desktop::e2e::E2eGate;
use memry_desktop::e2e::control::{self, ControlError};
use memry_desktop::e2e::dialog_queue::DialogQueue;
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

/// A context menu under test: records the items and answers from the queued selection. `None`
/// when the gate is closed or no selection is queued, so the real menu shows.
pub fn context_menu_override<R: Runtime>(
    app: &AppHandle<R>,
    items: &[crate::menu::popup::ContextMenuItem],
) -> Option<Option<String>> {
    shell::context_menu_override(app, items)
}

/// A hand-off to the OS under an open gate: records it and reports `true`.
pub fn record_os_open<R: Runtime>(app: &AppHandle<R>, what: &str) -> bool {
    reveal::record_os_open(app, what)
}

/// `vault_reveal` under an open gate: records the path and reports `true`.
pub fn record_reveal<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    reveal::record(app, path)
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
    startup::register(Stage::Plugins, "e2e dialog queue", manage_dialog_queue);
    startup::register(Stage::Handlers, "e2e forced failure", force_startup_failure);
}

/// `MEMRY_TEST_FORCE_STARTUP_THROW=1` fails startup before the main window exists, the failure
/// `startup-recovery.e2e.ts` recovers from.
fn force_startup_failure(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let env = app.state::<LaunchEnv>();
    if E2eGate::from_env(&env).is_open() && env.get("MEMRY_TEST_FORCE_STARTUP_THROW") == Some("1") {
        return Err(CommandError::new(
            ErrorKind::Internal,
            "e2e_forced_startup_failure",
            "forced startup failure (MEMRY_TEST_FORCE_STARTUP_THROW)",
        ));
    }
    Ok(())
}

/// The dialog queue and the reveal log exist only with an open gate; `shell/dialogs.rs` and
/// `vault_reveal` consult them when they do.
fn manage_dialog_queue(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let env = app.state::<LaunchEnv>();
    if !E2eGate::from_env(&env).is_open() {
        return Ok(());
    }
    let queue = DialogQueue::from_env(&env).map_err(|error| {
        CommandError::new(ErrorKind::Invalid, "e2e_dialog_queue", error.to_string())
    })?;
    app.manage(std::sync::Arc::new(queue));
    app.manage(reveal::RevealLog::default());
    app.manage(reveal::OsOpenLog::default());
    app.manage(shell::ContextMenuProbe::default());
    Ok(())
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
