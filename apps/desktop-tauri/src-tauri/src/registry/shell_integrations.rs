//! The badge and flush commands and the flush event.

macro_rules! shell_integrations {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shell_integrations::badge_set,
            // flush
            crate::commands::shell_integrations::flush_done,
            crate::commands::shell_integrations::flush_ready,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::FlushRequestedEvent,
        ] $($chain)*)
    };
}
