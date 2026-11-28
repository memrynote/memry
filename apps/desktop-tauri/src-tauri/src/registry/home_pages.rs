//! The Home board commands and events.

macro_rules! home_pages {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // home pages (`home_pages_set_cover_upload` is a binary command)
            crate::commands::home_pages::home_pages_create::<Wry>,
            crate::commands::home_pages::home_pages_delete::<Wry>,
            crate::commands::home_pages::home_pages_get::<Wry>,
            crate::commands::home_pages::home_pages_list::<Wry>,
            crate::commands::home_pages::home_pages_materialize_cover::<Wry>,
            crate::commands::home_pages::home_pages_remove_cover::<Wry>,
            crate::commands::home_pages::home_pages_reorder::<Wry>,
            crate::commands::home_pages::home_pages_set_cover::<Wry>,
            crate::commands::home_pages::home_pages_set_cover_framing::<Wry>,
            crate::commands::home_pages::home_pages_update::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::HomePageCreatedEvent,
            crate::events::HomePageDeletedEvent,
            crate::events::HomePageUpdatedEvent,
        ] $($chain)*)
    };
}
