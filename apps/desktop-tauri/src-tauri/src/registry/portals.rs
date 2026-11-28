//! The portal commands and event.

macro_rules! portals {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::portals::portals_get_usage::<Wry>,
            crate::commands::portals::portals_search::<Wry>,
            crate::commands::portals::portals_stamp_anchor::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::PortalsUsageChangedEvent,
        ] $($chain)*)
    };
}
