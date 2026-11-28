//! The notification commands.

macro_rules! notification {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shell_integrations::notification_permission,
            crate::commands::shell_integrations::notification_show,
            crate::commands::shell_integrations::notification_supported,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
