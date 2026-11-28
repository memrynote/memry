//! The locale commands and event.

macro_rules! locale {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::locale::locale_get,
            crate::commands::locale::locale_list,
            crate::commands::locale::locale_set,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::LocaleChangedEvent,
        ] $($chain)*)
    };
}
