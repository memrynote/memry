//! The drop staging commands.

macro_rules! drop_stage {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::drop_stage::drop_os_drag_uris,
            crate::commands::drop_stage::drop_stage_begin,
            crate::commands::drop_stage::drop_stage_finish,
            crate::commands::drop_stage::drop_stage_os_files,
            crate::commands::drop_stage::drop_stage_release,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
