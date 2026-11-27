//! The custom icon commands and event.

macro_rules! custom_icons {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // custom icons (`custom_icons_add` is a binary command)
            crate::commands::custom_icons::custom_icons_add_from_url,
            crate::commands::custom_icons::custom_icons_delete,
            crate::commands::custom_icons::custom_icons_list,
            crate::commands::custom_icons::custom_icons_rename,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::CustomIconsUpdatedEvent,
        ] $($chain)*)
    };
}
