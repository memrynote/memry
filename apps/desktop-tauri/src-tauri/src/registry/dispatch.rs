//! Routes an IPC call to the binary handler or the specta handler.

use tauri::ipc::Invoke;
use tauri::{Runtime, Wry};
use tauri_specta::Builder;

use crate::binary;

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

pub fn invoke_handler(
    builder: &Builder<Wry>,
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    dispatcher(
        binary::COMMANDS,
        binary::handler(),
        builder.invoke_handler(),
    )
}
