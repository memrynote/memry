//! The search commands.

macro_rules! search {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::search::search_add_reason::<Wry>,
            crate::commands::search::search_clear_reasons::<Wry>,
            crate::commands::search::search_get_reasons::<Wry>,
            crate::commands::search::search_get_stats::<Wry>,
            crate::commands::search::search_query::<Wry>,
            crate::commands::search::search_quick::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
