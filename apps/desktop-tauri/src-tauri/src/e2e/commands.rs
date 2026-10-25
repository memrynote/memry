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
    window => [e2e_windows, e2e_set_window_rect],
}
