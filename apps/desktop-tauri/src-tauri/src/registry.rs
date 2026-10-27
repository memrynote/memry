//! The single command list. Add a domain's commands under its comment, one fully qualified path
//! per line, domains in alphabetical order, and its module under `src/commands/`.

use tauri::ipc::Invoke;
use tauri::{Runtime, Wry};
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands, collect_events};

use crate::binary;
use crate::startup::StartupState;

pub fn builder() -> Builder<Wry> {
    Builder::<Wry>::new()
        // A rejected command throws the serialized `CommandError`, which `extractErrorMessage`
        // reads; no `{ status }` result wrapper in the renderer.
        .error_handling(ErrorHandlingMode::Throw)
        // Every `i64` that crosses IPC is an epoch-millisecond timestamp, a count or a size,
        // which the Electron renderer already holds as a JavaScript number. Ids and hashes
        // travel as strings.
        .dangerously_cast_bigints_to_number()
        // One type per struct: the renderer reads `StartupState` and never writes it.
        .disable_serde_phases()
        .commands(collect_commands![
            // app
            crate::commands::app::app_info,
            // diagnostics
            crate::commands::diagnostics::diagnostics_preview_report,
            crate::commands::diagnostics::diagnostics_send_report,
            // feedback
            crate::commands::telemetry::feedback_submit,
            // flush
            crate::commands::shell_integrations::flush_done,
            // locale
            crate::commands::locale::locale_get,
            crate::commands::locale::locale_list,
            crate::commands::locale::locale_set,
            // log
            crate::commands::logging::log_write,
            // settings
            crate::commands::settings::app_set_zoom_factor,
            crate::commands::settings::settings_get_group,
            crate::commands::settings::settings_get_local,
            crate::commands::settings::settings_get_path,
            crate::commands::settings::settings_reset_keyboard,
            crate::commands::settings::settings_set_group,
            crate::commands::settings::settings_set_local,
            // shell
            crate::commands::shell::shell_first_paint,
            crate::commands::shell::shell_heartbeat,
            // telemetry
            crate::commands::telemetry::telemetry_flush,
            crate::commands::telemetry::telemetry_get_settings,
            crate::commands::telemetry::telemetry_set_auto_send_diagnostics,
            crate::commands::telemetry::telemetry_set_enabled,
            crate::commands::telemetry::telemetry_track,
            // vault
            crate::commands::vault::vault_close,
            crate::commands::vault::vault_create,
            crate::commands::vault::vault_get_default_parent,
            crate::commands::vault::vault_get_status,
            crate::commands::vault::vault_list,
            crate::commands::vault::vault_remove,
            crate::commands::vault::vault_reveal,
            crate::commands::vault::vault_select,
            crate::commands::vault::vault_set_default,
            crate::commands::vault::vault_set_icon,
            crate::commands::vault::vault_switch,
        ])
        .events(collect_events![
            // flush
            crate::events::FlushRequestedEvent,
            // locale
            crate::events::LocaleChangedEvent,
            // settings
            crate::events::SettingsChangedEvent,
            crate::events::SettingsOpenSectionEvent,
            // vault
            crate::events::VaultErrorEvent,
            crate::events::VaultIndexRecoveredEvent,
            crate::events::VaultListChangedEvent,
            crate::events::VaultStatusChangedEvent,
        ])
        .typ::<StartupState>()
}

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
