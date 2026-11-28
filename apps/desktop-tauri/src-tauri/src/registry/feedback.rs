//! The feedback command.

macro_rules! feedback {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::telemetry::feedback_submit,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
