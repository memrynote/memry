//! The e2e command list. A domain step adds its module under `src/e2e/` and one line here.
//! The macro builds the handler and the name list from the same tokens, so
//! `e2e_commands_use_prefix` sees exactly what the dispatcher routes.

use tauri::Wry;
use tauri::ipc::Invoke;

macro_rules! e2e_commands {
    ($($module:ident => [$($command:ident),+ $(,)?]),+ $(,)?) => {
        /// Every registered command name.
        pub const NAMES: &[&str] = &[$($(stringify!($command)),+),+];

        pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($(crate::e2e::$module::$command),+),+]
        }
    };
}

e2e_commands! {
    app => [e2e_app_info, e2e_request_quit, e2e_emit],
    clipboard => [e2e_clipboard_read, e2e_clipboard_write],
    crash => [e2e_trigger_crash],
    debug => [e2e_debug_query, e2e_debug_index_query],
    os_drag => [e2e_offer_os_drag],
    dialog => [e2e_dialog_queue_push, e2e_dialog_queue_clear],
    reveal => [e2e_revealed_paths, e2e_os_opens],
    shell_integrations => [
        e2e_apply_login_item,
        e2e_close_window,
        e2e_fire_global_capture,
        e2e_forget_spelled_word,
        e2e_global_shortcut_state,
        e2e_hide_to_tray,
        e2e_post_power_event,
        e2e_save_held_edit,
        e2e_send_session_end,
        e2e_tray_probe,
        e2e_request_flush,
        e2e_trigger_shutdown_overrun
    ],
    shell => [
        e2e_set_next_context_menu_selection,
        e2e_last_context_menu_items,
        e2e_menu_tree,
        e2e_menu_activate,
        e2e_menu_bar_visible
    ],
    updater => [e2e_updater_script, e2e_updater_hook_calls],
    window => [e2e_windows, e2e_set_window_rect],
}
