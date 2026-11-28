//! The app info command and the navigation event.

macro_rules! app {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::app::app_info,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::AppNavigationRequestedEvent,
        ] $($chain)*)
    };
}
