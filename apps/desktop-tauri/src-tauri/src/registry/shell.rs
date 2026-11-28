//! The shell commands.

macro_rules! shell {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shell::shell_clipboard_read_text,
            crate::commands::shell::shell_first_paint,
            crate::commands::shell::shell_heartbeat,
            crate::commands::shell::shell_show_context_menu,
            crate::commands::shell::shell_open_external,
            crate::commands::shell::shell_open_link,
            crate::commands::shell::shell_open_path,
            crate::commands::shell::shell_reveal_path,
            crate::commands::shell::shell_take_crash_reload,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
