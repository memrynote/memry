//! The terminal command install commands.

macro_rules! terminal_command {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::terminal_command::settings_get_terminal_command_status,
            crate::commands::terminal_command::settings_install_terminal_command,
            crate::commands::terminal_command::settings_set_terminal_command_default_vault,
            crate::commands::terminal_command::settings_uninstall_terminal_command,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
