//! The menu commands and event.

macro_rules! menu {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shell::menu_hide_alt,
            crate::commands::shell::menu_toggle_alt,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::MenuCommandInvokedEvent,
        ] $($chain)*)
    };
}
