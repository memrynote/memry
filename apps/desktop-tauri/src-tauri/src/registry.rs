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
            // badge
            crate::commands::shell_integrations::badge_set,
            // flush
            crate::commands::shell_integrations::flush_done,
            // locale
            crate::commands::locale::locale_get,
            crate::commands::locale::locale_list,
            crate::commands::locale::locale_set,
            // notification
            crate::commands::shell_integrations::notification_permission,
            crate::commands::shell_integrations::notification_show,
            crate::commands::shell_integrations::notification_supported,
            // shortcut
            crate::commands::shortcuts::shortcut_register_global_capture,
            crate::commands::shortcuts::shortcut_set_global_capture,
            // spell
            crate::commands::spell::spell_check_word,
            crate::commands::spell::spell_add_word,
            crate::commands::spell::spell_add_words,
            // fonts
            crate::fonts::system_fonts_list,
            // log
            crate::commands::logging::log_write,
            // menu
            crate::commands::shell::menu_hide_alt,
            crate::commands::shell::menu_toggle_alt,
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
            crate::commands::shell::shell_show_context_menu,
            // telemetry
            crate::commands::telemetry::telemetry_flush,
            crate::commands::telemetry::telemetry_get_settings,
            crate::commands::telemetry::telemetry_set_auto_send_diagnostics,
            crate::commands::telemetry::telemetry_set_enabled,
            crate::commands::telemetry::telemetry_track,
            // unsplash
            crate::commands::unsplash::unsplash_search,
            // updater
            crate::commands::updater::updater_check_for_updates,
            crate::commands::updater::updater_download_update,
            crate::commands::updater::updater_get_state,
            crate::commands::updater::updater_quit_and_install,
            crate::commands::updater::updater_set_auto_check,
            crate::commands::updater::updater_set_auto_download,
            crate::commands::updater::updater_skip_version,
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
            // window
            crate::commands::shell::window_close,
            crate::commands::shell::window_minimize,
            crate::commands::shell::window_set_caption_rects,
            crate::commands::shell::window_toggle_maximize,
        ])
        .events(collect_events![
            // app
            crate::events::AppNavigationRequestedEvent,
            // flush
            crate::events::FlushRequestedEvent,
            // inbox
            crate::events::InboxOpenItemEvent,
            // locale
            crate::events::LocaleChangedEvent,
            // settings
            crate::events::SettingsChangedEvent,
            crate::events::SettingsOpenSectionEvent,
            // menu
            crate::events::MenuCommandInvokedEvent,
            // updater
            crate::events::UpdaterStateChangedEvent,
            // vault
            crate::events::VaultErrorEvent,
            crate::events::VaultIndexRecoveredEvent,
            crate::events::VaultListChangedEvent,
            crate::events::VaultStatusChangedEvent,
            // window
            crate::events::WindowCaptionHoverChangedEvent,
            crate::events::WindowCaptionPressedChangedEvent,
            crate::events::WindowChromeStateChangedEvent,
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
