//! Routes an IPC call to the binary handler or the specta handler, behind the window gate.

use tauri::ipc::Invoke;
use tauri::{Runtime, Wry};
use tauri_specta::Builder;

use crate::binary;
use crate::commands::error::{CommandError, ErrorKind};
use crate::windows::registry::WindowKind;

/// Sends a call to the binary handler when `command` is one of `binary_commands` and to the
/// specta handler otherwise. Step 03 (#3520) wraps this closure with its `e2e_` dispatcher.
pub fn dispatcher<R: Runtime>(
    binary_commands: &'static [&'static str],
    binary_handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    typed_handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if binary_commands.contains(&invoke.message.command()) {
            binary_handler(invoke)
        } else {
            typed_handler(invoke)
        }
    }
}

/// The commands of the preboot window's migration view (`crate::migration`).
pub const PREBOOT_COMMANDS: [&str; 3] = [
    "migration_status",
    "migration_retry",
    "migration_open_report",
];

/// Whether the window labelled `label` may call the app command `command`: the `preboot`
/// window only [`PREBOOT_COMMANDS`], the `startup-error` window none, and every other window
/// all but those. Tauri checks app commands against the capability files only once the app
/// declares an app manifest, which would have to list every command, so this gate keeps the
/// preboot page to what it needs instead.
pub fn window_allows(label: &str, command: &str) -> bool {
    match WindowKind::of_label(label) {
        Some(WindowKind::Preboot) => PREBOOT_COMMANDS.contains(&command),
        Some(WindowKind::StartupError) => false,
        _ => !PREBOOT_COMMANDS.contains(&command),
    }
}

/// Rejects a call [`window_allows`] refuses, before `handler` sees it.
pub fn window_gate<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let label = invoke.message.webview_ref().label();
        let command = invoke.message.command();
        if window_allows(label, command) {
            return handler(invoke);
        }
        let error = CommandError::new(
            ErrorKind::Invalid,
            "window_not_allowed",
            format!("{command} is not available in the {label} window"),
        );
        crate::commands::error::log_failure(command, &error);
        invoke.resolver.reject(error);
        true
    }
}

pub fn invoke_handler(
    builder: &Builder<Wry>,
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    window_gate(dispatcher(
        binary::COMMANDS,
        binary::handler(),
        builder.invoke_handler(),
    ))
}
