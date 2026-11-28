//! The global shortcut commands.

macro_rules! shortcuts {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shortcuts::shortcut_register_global_capture,
            crate::commands::shortcuts::shortcut_set_global_capture,
            crate::commands::shortcuts::shortcut_register_sticky,
            crate::commands::shortcuts::shortcut_set_sticky,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
