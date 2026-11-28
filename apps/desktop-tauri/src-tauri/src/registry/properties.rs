//! The property commands.

macro_rules! properties {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::properties::properties_get::<Wry>,
            crate::commands::properties::properties_merge::<Wry>,
            crate::commands::properties::properties_rename::<Wry>,
            crate::commands::properties::properties_resolve_refs::<Wry>,
            crate::commands::properties::properties_set::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
