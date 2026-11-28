//! The launch timeline command.

macro_rules! launch {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::launch::launch_report_renderer_marks,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
