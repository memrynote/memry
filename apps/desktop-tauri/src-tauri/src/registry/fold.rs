//! The note fold commands.

macro_rules! fold {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::fold::fold_get_agent_status::<Wry>,
            crate::commands::fold::fold_get_last_run::<Wry>,
            crate::commands::fold::fold_retry::<Wry>,
            crate::commands::fold::fold_run::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
