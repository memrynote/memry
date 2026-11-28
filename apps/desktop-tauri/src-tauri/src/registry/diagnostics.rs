//! The diagnostics report commands.

macro_rules! diagnostics {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::diagnostics::diagnostics_preview_report,
            crate::commands::diagnostics::diagnostics_send_report,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
