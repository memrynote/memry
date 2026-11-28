//! The telemetry commands.

macro_rules! telemetry {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::telemetry::telemetry_flush,
            crate::commands::telemetry::telemetry_get_settings,
            crate::commands::telemetry::telemetry_set_auto_send_diagnostics,
            crate::commands::telemetry::telemetry_set_enabled,
            crate::commands::telemetry::telemetry_track,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
