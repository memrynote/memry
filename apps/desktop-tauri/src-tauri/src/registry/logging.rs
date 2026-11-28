//! The renderer log command.

macro_rules! logging {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::logging::log_write,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
